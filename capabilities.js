// Tuck Shop capability registry. Each entry: { description, args, handler(args) → {result}|{error} }.
// Generic, stateless tools shared across the ecosystem (web search, fetch, papers, FX).
import { getKey } from './lib/key-store.js';
import { safeFetch } from './lib/ssrf.js';
import { renderPage, RenderBusyError } from './lib/render.js';
import { extractContent, stripHtml } from './lib/extract.js';
import { pdfToText } from './lib/pdf.js';
import { platformFetch } from './lib/readers.js';
import { TtlCache } from './lib/cache.js';
import { execFile } from 'node:child_process';
import { cognitiveCapabilities } from './cognitive.js';

// YouTube transcripts: pure-Node caption fetch is dead (YouTube returns 200/empty
// to naive requests). The Python youtube-transcript-api keeps up with their
// anti-scraping, so shell out to the already-installed lib via python3.11.
const PYTHON = process.env.PYTHON_PATH || '/opt/homebrew/bin/python3.11';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:3465';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const fetchCache = new TtlCache({ max: 100, ttlMs: 300000 });

// ---- web_search: SearXNG (self-hosted) → Serper → Brave ---------------------
async function webSearch({ query, limit = 5, recency } = {}) {
  if (!query) return { error: 'query is required' };
  const n = Math.min(Math.max(limit, 1), 10);

  try {
    const u = new URL(`${SEARXNG_URL}/search`);
    u.searchParams.set('q', query); u.searchParams.set('format', 'json');
    u.searchParams.set('language', 'en'); u.searchParams.set('safesearch', '0');
    if (recency) u.searchParams.set('time_range', recency); // day|week|month|year (SearXNG)
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

// SPA shell signature: external script bundle, common root ids, framework attrs, noscript hint.
function looksLikeSpaShell(rawHtml, strippedText) {
  const thin = strippedText.length < 400 ||
    (rawHtml.length > 5000 && strippedText.length / rawHtml.length < 0.015);
  if (!thin) return false;
  if (/<script\b[^>]*\bsrc\s*=/i.test(rawHtml)) return true;
  if (/id\s*=\s*["']?(root|app|__next)["']/i.test(rawHtml)) return true;
  if (/data-reactroot|ng-app/i.test(rawHtml)) return true;
  if (/<noscript\b[^>]*>[\s\S]*?(javascript|enable)/i.test(rawHtml)) return true;
  return false;
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

// Build intermediate "material" from an HTML source — the un-paged full extraction.
// materialize() turns this into the final paged result for any offset/maxChars.
function buildPageMaterial(finalUrl, rawHtml, mode) {
  const material = { kind: 'page', finalUrl };
  if (mode === 'links' || mode === 'both') {
    material.links = extractLinks(rawHtml, finalUrl);
  }
  if (mode !== 'links') {
    const { text, title, byline, meta } = extractContent(rawHtml, finalUrl);
    material.fullText = text;
    if (title) material.title = title;
    if (byline) material.byline = byline;
    material.meta = meta;
  }
  return material;
}

// Pure function: turn cached material into the final paged result.
function materialize(material, mode, off, maxChars) {
  if (material.kind === 'social') return material.result;
  if (material.kind === 'platform') {
    const result = material.result;
    if (result.platform === 'github' && result.readme) {
      const readme = result.readme;
      const content = readme.slice(off, off + maxChars);
      const { readme: _, ...rest } = result;
      return {
        ...rest,
        content,
        chars: readme.length,
        truncated: off + content.length < readme.length,
        ...(off > 0 ? { offset: off } : {}),
      };
    }
    return result;
  }
  if (material.kind === 'pdf') {
    const content = material.text.slice(off, off + maxChars);
    return {
      url: material.finalUrl,
      readable: true,
      content_type: 'application/pdf',
      chars: material.text.length,
      truncated: off + content.length < material.text.length,
      content,
      ...(off > 0 ? { offset: off } : {}),
      ...(material.archived ? { archived: true, archive_url: material.archive_url, archive_date: material.archive_date } : {}),
    };
  }
  // kind === 'page'
  const out = { url: material.finalUrl, readable: true };
  if (material.links !== undefined) out.links = material.links;
  if (material.fullText !== undefined) {
    const content = material.fullText.slice(off, off + maxChars);
    out.chars = material.fullText.length;
    out.truncated = off + content.length < material.fullText.length;
    out.content = content;
    if (off > 0) out.offset = off;
    if (material.title) out.title = material.title;
    if (material.byline) out.byline = material.byline;
    if (material.meta) {
      if (material.meta.og_description) out.og_description = material.meta.og_description;
      if (material.meta.canonical) out.canonical = material.meta.canonical;
      if (material.meta.site_name) out.site_name = material.meta.site_name;
    }
  }
  if (material.rendered) out.rendered = true;
  if (material.render_attempted) out.render_attempted = true;
  if (material.note) out.note = material.note;
  if (material.archived) out.archived = true;
  if (material.archive_url) out.archive_url = material.archive_url;
  if (material.archive_date) out.archive_date = material.archive_date;
  return out;
}

// Wayback fallback: for 403/404/410/451, try the Internet Archive.
// Returns { result } on success, or null (caller returns original error).
async function tryWayback(originalUrl, mode, off, maxChars, render) {
  try {
    const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    const snap = j?.archived_snapshots?.closest;
    if (!snap?.available) return null;
    const snapUrl = snap.url.replace(/^http:\/\//, 'https://');

    const fetched = await safeFetch(snapUrl, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
    });
    if (!fetched.res.ok) return null;
    const ctype = (fetched.res.headers.get('content-type') || '').toLowerCase();

    if (ctype.includes('application/pdf')) {
      const buf = Buffer.from(await fetched.res.arrayBuffer());
      if (buf.length > 20 * 1024 * 1024) return null;
      const text = await pdfToText(buf);
      if (!text) return null;
      const material = { kind: 'pdf', finalUrl: fetched.finalUrl, text, archived: true, archive_url: snap.url, archive_date: snap.timestamp };
      fetchCache.set(originalUrl + '|' + mode + '|' + (render === true), material);
      return { result: materialize(material, mode, off, maxChars) };
    }

    if (ctype && !/(text|html|json|xml)/.test(ctype)) return null;

    const raw = await fetched.res.text();
    const material = buildPageMaterial(fetched.finalUrl, raw, mode);
    material.archived = true;
    material.archive_url = snap.url;
    material.archive_date = snap.timestamp;
    fetchCache.set(originalUrl + '|' + mode + '|' + (render === true), material);
    return { result: materialize(material, mode, off, maxChars) };
  } catch {
    return null;
  }
}

async function fetchUrl({ url, mode = 'text', render, offset = 0, max_chars } = {}) {
  if (!url) return { error: 'url is required' };

  // Paging args: offset (min 0), max_chars (min 1, hard cap 20000, default 8000).
  const off = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  let maxChars = max_chars == null ? 8000 : max_chars;
  if (!Number.isFinite(maxChars) || maxChars < 1) maxChars = 8000;
  maxChars = Math.min(maxChars, 20000);

  const cacheKey = url + '|' + mode + '|' + (render === true);
  const cached = fetchCache.get(cacheKey);
  if (cached) return { result: materialize(cached, mode, off, maxChars) };

  // Social readers (X/YouTube/TikTok/Instagram).
  const social = await socialFetch(url);
  if (social) {
    if (social.readable !== false) fetchCache.set(cacheKey, { kind: 'social', result: social });
    return { result: social };
  }

  // Platform readers (GitHub/Reddit/HN).
  const plat = await platformFetch(url);
  if (plat) {
    if (plat.readable !== false) fetchCache.set(cacheKey, { kind: 'platform', result: plat });
    if (plat.platform === 'github' && plat.readme) {
      const content = plat.readme.slice(off, off + maxChars);
      const { readme: _, ...rest } = plat;
      return { result: { ...rest, content, chars: plat.readme.length, truncated: off + content.length < plat.readme.length, ...(off > 0 ? { offset: off } : {}) } };
    }
    return { result: plat };
  }

  let target = url;
  if (/arxiv\.org\/pdf\//i.test(target)) target = target.replace('/pdf/', '/abs/').replace(/\.pdf$/i, '');

  // www.reddit.com serves a JS bot-check shell; old.reddit.com serves real HTML.
  try {
    const ru = new URL(target);
    if (ru.hostname === 'reddit.com' || ru.hostname === 'www.reddit.com' || ru.hostname === 'np.reddit.com') {
      ru.hostname = 'old.reddit.com';
      target = ru.toString();
    }
  } catch {}

  // render: true → skip plain fetch entirely.
  if (render === true) {
    try {
      const { html, finalUrl } = await renderPage(target, { budgetMs: 15000, userAgent: UA });
      const material = buildPageMaterial(finalUrl, html, mode);
      material.rendered = true;
      fetchCache.set(cacheKey, material);
      return { result: materialize(material, mode, off, maxChars) };
    } catch (err) {
      return { error: `Render failed: ${err.message}` };
    }
  }

  // Plain fetch (default and render:false paths).
  let raw, finalUrl, ctype;
  try {
    const fetched = await safeFetch(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
    });
    if (!fetched.res.ok) {
      // Wayback fallback for 403/404/410/451 (plain-fetch path only).
      if (render !== true && [403, 404, 410, 451].includes(fetched.res.status)) {
        const wayback = await tryWayback(url, mode, off, maxChars, render);
        if (wayback) return wayback;
      }
      return { error: `Fetch failed: HTTP ${fetched.res.status}` };
    }
    finalUrl = fetched.finalUrl;
    ctype = (fetched.res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/pdf')) {
      const lenHdr = fetched.res.headers.get('content-length');
      if (lenHdr && Number(lenHdr) > 20 * 1024 * 1024) {
        return { result: { url: finalUrl, content_type: ctype, readable: false, note: `PDF too large (${Math.round(Number(lenHdr) / 1048576)}MB, 20MB cap).`, content: '' } };
      }
      const buf = Buffer.from(await fetched.res.arrayBuffer());
      if (buf.length > 20 * 1024 * 1024) {
        return { result: { url: finalUrl, content_type: ctype, readable: false, note: `PDF too large (${Math.round(buf.length / 1048576)}MB, 20MB cap).`, content: '' } };
      }
      const text = await pdfToText(buf);
      if (!text) {
        const hint = /arxiv\.org/i.test(finalUrl) ? ' Try the arxiv.org/abs/ or arxiv.org/html/ version.' : ' If this is a paper, fetch its HTML/abstract page instead of the PDF.';
        return { result: { url: finalUrl, content_type: ctype, readable: false, note: `PDF text extraction failed.${hint}`, content: '' } };
      }
      const material = { kind: 'pdf', finalUrl, text };
      fetchCache.set(cacheKey, material);
      return { result: materialize(material, mode, off, maxChars) };
    }
    if (ctype && !/(text|html|json|xml)/.test(ctype)) {
      const hint = /arxiv\.org/i.test(finalUrl) ? ' Try the arxiv.org/abs/ or arxiv.org/html/ version.' : ' If this is a paper, fetch its HTML/abstract page instead of the PDF.';
      return { result: { url: finalUrl, content_type: ctype || 'unknown', readable: false, note: `Non-text content (${ctype || 'binary'}) can't be read directly.${hint}`, content: '' } };
    }
    raw = await fetched.res.text();
  } catch (err) {
    return { error: `Fetch failed: ${err.message}` };
  }

  const plainMaterial = buildPageMaterial(finalUrl, raw, mode);

  // render:false → plain only.
  if (render === false) {
    fetchCache.set(cacheKey, plainMaterial);
    return { result: materialize(plainMaterial, mode, off, maxChars) };
  }

  // Default path: auto-render fallback heuristic.
  const isHtml = /html|xml/.test(ctype) || ctype === '' || /<!doctype html|<html/i.test(raw);
  if (isHtml) {
    const strippedText = mode === 'links' ? '' : stripHtml(raw);
    if (looksLikeSpaShell(raw, strippedText)) {
      try {
        const r = await renderPage(target, { budgetMs: 12000, userAgent: UA });
        const renderedMaterial = buildPageMaterial(r.finalUrl, r.html, mode);
        const plainLen = mode === 'links' ? (plainMaterial.links?.length || 0) : (plainMaterial.fullText?.length || 0);
        const renderedLen = mode === 'links' ? (renderedMaterial.links?.length || 0) : (renderedMaterial.fullText?.length || 0);
        if (renderedLen > plainLen) {
          renderedMaterial.rendered = true;
          fetchCache.set(cacheKey, renderedMaterial);
          return { result: materialize(renderedMaterial, mode, off, maxChars) };
        }
        // Rendered but not better — keep plain, note the attempt. Do NOT cache.
        plainMaterial.render_attempted = true;
        plainMaterial.note = 'JS render produced no more text than static HTML; returning static HTML text.';
        return { result: materialize(plainMaterial, mode, off, maxChars) };
      } catch (err) {
        const reason = err instanceof RenderBusyError ? 'busy' : (err.message || 'unknown');
        plainMaterial.render_attempted = true;
        plainMaterial.note = `JS render failed (${reason}); returning static HTML text.`;
        return { result: materialize(plainMaterial, mode, off, maxChars) };
      }
    }
  }

  fetchCache.set(cacheKey, plainMaterial);
  return { result: materialize(plainMaterial, mode, off, maxChars) };
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
  web_search: { description: 'Search the live web (SearXNG → Serper → Brave). Args: {query, limit?, recency?: day|week|month|year}.', args: { query: 'string', limit: 'number?', recency: 'day|week|month|year?' }, handler: webSearch },
  fetch_url: { description: 'Fetch a URL as readable text (article-quality extraction, SSRF-safe, reads PDFs (≤20MB) as text). Handles X/Twitter, YouTube, TikTok, (best-effort) Instagram, GitHub, Reddit and Hacker News via per-platform readers. JS-rendered SPAs are rendered automatically; pass render:true to force, render:false to disable. Long pages: re-fetch with offset to continue reading. Unreachable pages fall back to the Internet Archive when a snapshot exists. Args: {url, mode?: text|links|both, render?: boolean, offset?: number, max_chars?: number}. arXiv PDFs auto-redirect to the abstract.', args: { url: 'string', mode: 'text|links|both?', render: 'boolean?', offset: 'number?', max_chars: 'number?' }, handler: fetchUrl },
  search_papers: { description: 'Search academic papers across HF, arXiv, and Semantic Scholar. Args: {query, source?: hf|arxiv|ss|all, limit?}.', args: { query: 'string', source: 'hf|arxiv|ss|all?', limit: 'number?' }, handler: searchPapers },
  search_models: { description: 'Search Hugging Face models. Args: {query, limit?}.', args: { query: 'string', limit: 'number?' }, handler: (a) => hfSearch('models', a) },
  search_datasets: { description: 'Search Hugging Face datasets. Args: {query, limit?}.', args: { query: 'string', limit: 'number?' }, handler: (a) => hfSearch('datasets', a) },
  convert_currency: { description: 'Convert an amount between currencies at live rates. Args: {amount, from, to}.', args: { amount: 'number', from: 'string', to: 'string' }, handler: convertCurrency },
  // Cognitive tools bridged from Train Tracks (calculator, datetime, probability,
  // statistics, thesaurus, units). Empty {} if the TT package is unavailable.
  ...cognitiveCapabilities,
};
