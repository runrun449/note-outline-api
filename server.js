import express from "express";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ====== 環境変数 ======
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const API_TOKEN = process.env.API_TOKEN || ""; // 任意（未設定なら認証なし）

// ====== 共通 ======
function requireAuth(req, res) {
  // API_TOKENが未設定なら認証なし（開発用）
  if (!API_TOKEN) return true;

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token !== API_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ====== ルート（Render / ブラウザ確認用）=====
app.get("/", (req, res) => {
  res.status(200).send("OK: note-outline-api is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/ping", (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * GET /note_top_outline?q=xxx&num=10
 * POST /note_top_outline { query: "xxx", num: 10 }
 *
 * return:
 * {
 *   query: "xxx site:note.com",
 *   results: [
 *     { rank, url, serp_title, page_title, h1, h2[], h3[], fetched_at }
 *   ]
 * }
 */

// GET版（ブラウザで確認しやすい）
app.get("/note_top_outline", async (req, res) => {
  const query = String(req.query?.q || "").trim();
  const num = Number(req.query?.num || 10);
  return handleNoteTopOutline(req, res, query, num);
});

// POST版（Actionsから叩く想定）
app.post("/note_top_outline", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  const num = Number(req.body?.num || 10);
  return handleNoteTopOutline(req, res, query, num);
});

async function handleNoteTopOutline(req, res, query, numRaw) {
  try {
    if (!requireAuth(req, res)) return;

    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: "SERPAPI_KEY is missing" });
    }

    const num = Math.min(Math.max(Number.isFinite(numRaw) ? numRaw : 10, 1), 10);
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    // ① Google検索（note.com限定）
    const serpQuery = `${query} site:note.com`;
    const serpUrl = new URL("https://serpapi.com/search.json");
    serpUrl.searchParams.set("engine", "google");
    serpUrl.searchParams.set("q", serpQuery);
    serpUrl.searchParams.set("hl", "ja");
    serpUrl.searchParams.set("gl", "jp");
    serpUrl.searchParams.set("num", String(num));
    serpUrl.searchParams.set("api_key", SERPAPI_KEY);

    const serpResp = await fetchWithTimeout(serpUrl.toString(), {}, 20000);
    if (!serpResp.ok) {
      const text = await serpResp.text().catch(() => "");
      return res.status(502).json({
        error: "SERP API failed",
        status: serpResp.status,
        detail: text.slice(0, 800),
      });
    }

    const serpJson = await serpResp.json().catch(() => ({}));
    const organic = Array.isArray(serpJson.organic_results) ? serpJson.organic_results : [];

    const top = organic
      .filter((r) => typeof r?.link === "string" && r.link.includes("note.com/"))
      .slice(0, num)
      .map((r, i) => ({
        rank: i + 1,
        url: r.link,
        serp_title: typeof r?.title === "string" ? r.title : "",
      }));

    if (top.length === 0) {
      return res.status(200).json({
        query: serpQuery,
        results: [],
        note: "No note.com results found in top organic results.",
      });
    }

    // ② 各noteページから H2/H3 抽出（最大10件）
    const results = [];
    for (const item of top) {
      const extracted = await extractHeadings(item.url);
      results.push({
        rank: item.rank,
        url: item.url,
        serp_title: item.serp_title,
        page_title: extracted.page_title,
        h1: extracted.h1,
        h2: extracted.h2,
        h3: extracted.h3,
        fetched_at: new Date().toISOString(),
      });
      await sleep(500);
    }

    return res.json({ query: serpQuery, results });
  } catch (e) {
    return res.status(500).json({
      error: "Internal error",
      detail: String(e?.message || e),
    });
  }
}

async function extractHeadings(url) {
  try {
    // noteは弾かれることがあるのでUser-Agent必須
    const resp = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          "Accept-Language": "ja,en;q=0.9",
        },
      },
      20000
    );

    if (!resp.ok) {
      return { page_title: "", h1: "", h2: [], h3: [] };
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const page_title = ($("title").first().text() || "").trim();
    const h1 = ($("h1").first().text() || "").replace(/\s+/g, " ").trim();

    const h2 = [];
    $("h2").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t) h2.push(t);
    });

    const h3 = [];
    $("h3").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t) h3.push(t);
    });

    // 長すぎ防止（GPTに渡す量を制限）
    return {
      page_title: page_title.slice(0, 200),
      h1: h1.slice(0, 200),
      h2: h2.slice(0, 20).map((x) => x.slice(0, 200)),
      h3: h3.slice(0, 40).map((x) => x.slice(0, 200)),
    };
  } catch (_e) {
    // タイムアウト/ブロック等でも落とさない
    return { page_title: "", h1: "", h2: [], h3: [] };
  }
}

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
});
