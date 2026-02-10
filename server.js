import express from "express";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ====== 設定（環境変数）======
const SERPAPI_KEY = process.env.SERPAPI_KEY; // SerpAPIのキー
const API_TOKEN = process.env.API_TOKEN;     // あなたのAPIを守るキー（任意の長い文字列）

function requireAuth(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!API_TOKEN) return true; // 未設定なら認証なし（開発用）
  if (token !== API_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/ping", (req, res) => res.json({ ok: true }));

/**
 * POST /note_top_outline
 * body: { query: string, num?: number }
 * return: { query, results:[{rank,url,serp_title,page_title,h1,h2[],h3[],fetched_at}] }
 */
app.post("/note_top_outline", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: "SERPAPI_KEY is missing" });
    }

    const query = String(req.body?.query || "").trim();
    const num = Math.min(Math.max(Number(req.body?.num || 10), 1), 10);

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

    const serpResp = await fetch(serpUrl.toString());
    if (!serpResp.ok) {
      const text = await serpResp.text();
      return res.status(502).json({ error: "SERP API failed", detail: text.slice(0, 500) });
    }
    const serpJson = await serpResp.json();

    const organic = Array.isArray(serpJson.organic_results) ? serpJson.organic_results : [];
    const top = organic
      .filter(r => typeof r?.link === "string" && r.link.includes("note.com/"))
      .slice(0, num)
      .map((r, i) => ({
        rank: i + 1,
        url: r.link,
        serp_title: r.title || ""
      }));

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
        fetched_at: new Date().toISOString()
      });
      // 連打対策（軽い間隔）
      await sleep(500);
    }

    res.json({ query: serpQuery, results });
  } catch (e) {
    res.status(500).json({ error: "Internal error", detail: String(e?.message || e) });
  }
});

async function extractHeadings(url) {
  // noteは弾かれることがあるのでUser-Agent必須
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    }
  });

  if (!resp.ok) {
    return { page_title: "", h1: "", h2: [], h3: [] };
  }
  const html = await resp.text();
  const $ = cheerio.load(html);

  const page_title = ($("title").first().text() || "").trim();
  const h1 = ($("h1").first().text() || "").trim();

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
    h2: h2.slice(0, 20).map(x => x.slice(0, 200)),
    h3: h3.slice(0, 40).map(x => x.slice(0, 200))
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
});
