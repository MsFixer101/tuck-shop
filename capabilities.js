// Tuck Shop capability registry. Each entry: { description, args, handler(args) → {result}|{error} }.
// Generic, stateless tools shared across the ecosystem (web search, fetch, papers, FX).
import { getKey } from './lib/key-store.js';
import { safeFetch } from './lib/ssrf.js';
import { execFile } from 'node:child_process';

// YouTube transcripts: pure-Node caption fetch is dead (YouTube returns 200/empty
// to naive requests). The Python youtube-transcript-api keeps up with their
// anti-scraping, so shell out to the already-installed lib via python3.11.
const PYTHON = process.env.PYTHON_PATH || '/opt/homebrew/bin/python3.11';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:3465';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- web_search: SearXNG (self-hosted) → Serper → Brave ---------------------
async function webSearch({ query, limit = 5 } = {}) {
  if (!query) return { error: 'query is required' };
  const n = Math.min(Math.max(limit, 1), 10);

  try {
    const u = new URL(`${SEARXNG_URL}/search`);
    u.searchParams.set('q', query); u.searchParams.set('format', 'json');
    u.searchParams.set('language', 'en'); u.searchParams.set('safesearch', '0');
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j = await r.json();
      const results = (j.results || []).slice(0, n).map(x => ({ title: x.title || 'Untitled', url: x.url, snippet: x.content || '' }));
      if (results.length) return { result: { query, source: 'searxng', results } };
    }
  } catch (e) { console.warn('[web_search] searxng:', e.message); }

  const serper = await getKey('serper');
  if (serper) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: n }),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.organic || []).slice(0, n).map(x => ({ title: x.title || 'Untitled', url: x.link, snippet: x.snippet || '' }));
        if (results.length) return { result: { query, source: 'serper', results } };
      }
    } catch (e) { console.warn('[web_search] serper:', e.message); }
  }

  const brave = await getKey('brave');
  if (brave) {
    try {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query); u.searchParams.set('count', String(n));
      const r = await fetch(u, { headers: { Accept: 'application/json', 'X-Subscription-Token': brave }, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const j = await r.json();
        const results = (j.web?.results || []).slice(0, n).map(x => ({ title: x.title || 'Untitled', url: x.url, snippet: x.description || '' }));
        if (results.length) return { result: { query, source: 'brave', results } };
      }
    } catch (e) { console.warn('[web_search] brave:', e.message); }
  }

  return { result: { query, source: 'none', results: [], note: 'All search providers returned nothing.' } };
}

// ---- fetch_url: SSRF-safe, PDF-aware, optional link extraction --------------
function extractLinks(html, baseUrl) {
  const out = []; const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 200) {
    let href = m[1].trim();
    try { href = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ url: href, text: text.slice(0, 120) });
  }
  return out;
}

function youtubeTranscript(id) {
  return new Promise((resolve) => {
    const script = 'import sys\n' +
      'try:\n' +
      '    from youtube_transcript_api import YouTubeTranscriptApi\n' +
      '    t = YouTubeTranscriptApi().fetch(sys.argv[1])\n' +
      '    sys.stdout.write(" ".join(s.text for s in t))\n' +
      'except Exception as e:\n' +
      '    sys.stderr.write("ERR:" + str(e))\n';
    execFile(PYTHON, ['-c', script, id], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const out = (stdout || '').trim();
      resolve(!err && out ? out.replace(/\s+/g, ' ') : null);
    });
  });
}

// YouTube: metadata via oEmbed (reliable), transcript via Python youtube-transcript-api.
async function youtubeFetch(url) {
  const id = (url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/) || [])[1];
  let meta = {};
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) { const j = await r.json(); meta = { title: j.title, author: j.author_name }; }
  } catch {}
  const transcript = id ? await youtubeTranscript(id) : null;
  if (!meta.title && !transcript) return { platform: 'youtube', url, readable: false, note: 'Could not fetch this video.' };
  return {
    platform: 'youtube', url, readable: true, ...meta,
    transcript_available: !!transcript,
    transcript: transcript ? transcript.slice(0, 12000) : null,
    ...(transcript ? {} : { note: 'Metadata only — no transcript available for this video.' }),
  };
}

// Social links are JS/login-walled; use per-platform readers instead of scraping.
async function socialFetch(url) {
  const tw = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  if (tw) {
    try {
      const r = await fetch(`https://api.fxtwitter.com/${tw[1]}/status/${tw[2]}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) { const t = (await r.json()).tweet; if (t) return { platform: 'x', url: t.url, readable: true, author: t.author?.screen_name, text: t.text, likes: t.likes, retweets: t.retweets, created: t.created_at, media: (t.media?.all || []).map(m => m.url) }; }
    } catch {}
    return { platform: 'x', url, readable: false, note: 'Could not fetch this tweet.' };
  }
  if (/(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/i.test(url)) {
    return youtubeFetch(url);
  }
  if (/tiktok\.com\//i.test(url)) {
    try {
      const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { const j = await r.json(); return { platform: 'tiktok', url, readable: true, title: j.title, author: j.author_name, author_url: j.author_url, thumbnail: j.thumbnail_url }; }
    } catch {}
    return { platform: 'tiktok', url, readable: false, note: 'Could not fetch this TikTok.' };
  }
  const ig = url.match(/instagram\.com\/(p|reel|reels|tv)\/([^/?#]+)/i);
  if (ig) {
    for (const host of ['kkinstagram.com', 'ddinstagram.com', 'instafix.io']) {
      try {
        const r = await fetch(`https://${host}/${ig[1]}/${ig[2]}/`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const html = await r.text();
          const title = (html.match(/<meta property="og:title" content="([^"]*)"/i) || [])[1];
          const desc = (html.match(/<meta property="og:description" content="([^"]*)"/i) || [])[1];
          if (title || desc) return { platform: 'instagram', url, readable: true, title, description: desc, note: `via ${host}` };
        }
      } catch {}
    }
    return { platform: 'instagram', url, readable: false, note: 'Instagram blocks scraping and the reader proxies were unreachable — open the link directly.' };
  }
  return null;
}

async function fetchUrl({ url, mode = 'text' } = {}) {
  if (!url) return { error: 'url is required' };
  const social = await socialFetch(url);
  if (social) return { result: social };
  let target = url;
  if (/arxiv\.org\/pdf\//i.test(target)) target = target.replace('/pdf/', '/abs/').replace(/\.pdf$/i, '');
  try {
    const { res, finalUrl } = await safeFetch(target, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
    });
    if (!res.ok) return { error: `Fetch failed: HTTP ${res.status}` };
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/pdf') || (ctype && !/(text|html|json|xml)/.test(ctype))) {
      const hint = /arxiv\.org/i.test(finalUrl) ? ' Try the arxiv.org/abs/ or arxiv.org/html/ version.' : ' If this is a paper, fetch its HTML/abstract page instead of the PDF.';
      return { result: { url: finalUrl, content_type: ctype || 'unknown', readable: false, note: `Non-text content (${ctype || 'binary'}) can't be read directly.${hint}`, content: '' } };
    }
    const raw = await res.text();
    const out = { url: finalUrl, readable: true };
    if (mode === 'links' || mode === 'both') out.links = extractLinks(raw, finalUrl);
    if (mode !== 'links') {
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      const max = 8000;
      out.chars = text.length; out.truncated = text.length > max; out.content = text.slice(0, max);
    }
    return { result: out };
  } catch (err) {
    return { error: `Fetch failed: ${err.message}` };
  }
}

// ---- search_papers: multi-source (HF + arXiv + Semantic Scholar) ------------
async function hfPapers(query, n) {
  const r = await fetch(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HF ${r.status}`);
  const items = await r.json();
  return (Array.isArray(items) ? items : []).slice(0, n).map(it => {
    const p = it.paper || {};
    return { source: 'hf', id: p.id, title: (it.title || p.title || '').replace(/\s+/g, ' ').trim(), summary: (it.summary || p.summary || '').replace(/\s+/g, ' ').slice(0, 300), url: p.id ? `https://arxiv.org/abs/${p.id}` : undefined };
  });
}
async function arxivPapers(query, n) {
  // https + let fetch follow the redirect the old http endpoint issued.
  const r = await fetch(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${n}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`arXiv ${r.status}`);
  const xml = await r.text();
  const out = [];
  const entries = xml.split('<entry>').slice(1);
  for (const e of entries.slice(0, n)) {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
    const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
    out.push({ source: 'arxiv', id: id.split('/abs/')[1] || id, title: title.replace(/\s+/g, ' ').trim(), summary: summary.replace(/\s+/g, ' ').trim().slice(0, 300), url: id.trim() });
  }
  return out;
}
async function ssPapers(query, n) {
  const headers = {};
  const key = await getKey('semanticscholar');
  if (key) headers['x-api-key'] = key;
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${n}&fields=title,abstract,year,externalIds,url`, { headers, signal: AbortSignal.timeout(10000) });
  if (r.status === 429) return []; // rate-limited without a key → skip cleanly
  if (!r.ok) throw new Error(`SS ${r.status}`);
  const j = await r.json();
  return (j.data || []).slice(0, n).map(p => ({ source: 'ss', id: p.externalIds?.ArXiv || p.paperId, title: (p.title || '').trim(), summary: (p.abstract || '').slice(0, 300), year: p.year, doi: p.externalIds?.DOI, url: p.url }));
}
async function searchPapers({ query, source = 'all', limit = 5 } = {}) {
  if (!query) return { error: 'query is required' };
  const n = Math.min(Math.max(limit, 1), 10);
  const want = source === 'all' ? ['hf', 'arxiv', 'ss'] : [source];
  const settled = await Promise.allSettled([
    want.includes('hf') ? hfPapers(query, n) : Promise.resolve([]),
    want.includes('arxiv') ? arxivPapers(query, n) : Promise.resolve([]),
    want.includes('ss') ? ssPapers(query, n) : Promise.resolve([]),
  ]);
  const all = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);
  const seen = new Set(); const deduped = [];
  for (const p of all) { const k = (p.title || '').toLowerCase().slice(0, 60); if (k && !seen.has(k)) { seen.add(k); deduped.push(p); } }
  return { result: { query, count: deduped.length, papers: deduped.slice(0, n * 2) } };
}

// ---- HF models / datasets ---------------------------------------------------
async function hfSearch(kind, { query, limit = 5 } = {}) {
  if (!query) return { error: 'query is required' };
  const n = Math.min(Math.max(limit, 1), 10);
  const r = await fetch(`https://huggingface.co/api/${kind}?search=${encodeURIComponent(query)}&limit=${n}&sort=downloads&direction=-1`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { error: `HF API error: ${r.status}` };
  const rows = await r.json();
  return { result: (rows || []).map(m => ({ id: m.id, downloads: m.downloads, likes: m.likes, url: `https://huggingface.co/${kind === 'models' ? '' : kind + '/'}${m.id}` })) };
}

// ---- convert_currency (live FX, no key) -------------------------------------
async function convertCurrency({ amount = 1, from, to } = {}) {
  const a = Number(amount);
  const f = (from || '').toUpperCase(); const t = (to || '').toUpperCase();
  if (!f || !t) return { error: 'from and to currency codes are required (e.g. USD, GBP)' };
  if (!Number.isFinite(a)) return { error: 'amount must be a number' };
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?amount=${a}&from=${f}&to=${t}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { error: `Currency API returned ${r.status}` };
    const j = await r.json();
    const converted = j.rates?.[t];
    if (converted == null) return { error: `No rate for ${f}→${t}` };
    return { result: { amount: a, from: f, to: t, converted, rate: converted / a, date: j.date, message: `${a} ${f} = ${converted} ${t} (as of ${j.date})` } };
  } catch (err) {
    return { error: `Currency conversion failed: ${err.message}` };
  }
}

export const CAPABILITIES = {
  web_search: { description: 'Search the live web (SearXNG → Serper → Brave). Args: {query, limit?}.', args: { query: 'string', limit: 'number?' }, handler: webSearch },
  fetch_url: { description: 'Fetch a URL as readable text (SSRF-safe, PDF-aware). Handles X/Twitter, YouTube, TikTok and (best-effort) Instagram via per-platform readers. Args: {url, mode?: text|links|both}. arXiv PDFs auto-redirect to the abstract.', args: { url: 'string', mode: 'text|links|both?' }, handler: fetchUrl },
  search_papers: { description: 'Search academic papers across HF, arXiv, and Semantic Scholar. Args: {query, source?: hf|arxiv|ss|all, limit?}.', args: { query: 'string', source: 'hf|arxiv|ss|all?', limit: 'number?' }, handler: searchPapers },
  search_models: { description: 'Search Hugging Face models. Args: {query, limit?}.', args: { query: 'string', limit: 'number?' }, handler: (a) => hfSearch('models', a) },
  search_datasets: { description: 'Search Hugging Face datasets. Args: {query, limit?}.', args: { query: 'string', limit: 'number?' }, handler: (a) => hfSearch('datasets', a) },
  convert_currency: { description: 'Convert an amount between currencies at live rates. Args: {amount, from, to}.', args: { amount: 'number', from: 'string', to: 'string' }, handler: convertCurrency },
};
