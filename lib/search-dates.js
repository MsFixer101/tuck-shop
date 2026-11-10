// web_search date limits and exclusions (k-0660, for the blog workbench k-0657): "only what could be found
// before the post's date, and leave the post itself out".
//
// Serper and Brave take a date range in the query. SearXNG (the live default) has only day/week/month/year,
// so a dated SearXNG search is CHECKED instead, result by result:
//   1. the page's own publish date (article:published_time, datePublished and the like), read from the page;
//   2. if the page gives none, the day the Internet Archive first saved it, RATIONED: at most
//      ARCHIVE_PER_MIN lookups a minute, and none for 30 minutes after the Archive refuses or rate-limits us
//      (10 Nov 2026: ~50 lookups in two minutes got this network's connections refused).
// A result with no date from either, or not checked in time, is left out and counted, never guessed.
import { TtlCache } from './cache.js';
import { safeFetch } from './ssrf.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string that is a real date, or null when absent. Throws with a plain message otherwise. */
export function parseDay(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !DAY_RE.test(value)) throw new Error(`${name} must be a date written YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error(`${name} is not a real date: ${value}`);
  return value;
}

export function dayBefore(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const EARLIEST = '1995-01-01';
const RECENCY = { day: ['d', 'pd'], week: ['w', 'pw'], month: ['m', 'pm'], year: ['y', 'py'] };

/** Serper's `tbs`: a custom date range (before = up to the day before) or a recency window; null for neither. */
export function serperTbs({ before, after, recency } = {}) {
  if (before || after) {
    const us = (day) => { const [y, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
    return `cdr:1,cd_min:${us(after || EARLIEST)},cd_max:${before ? us(dayBefore(before)) : ''}`;
  }
  return RECENCY[recency] ? `qdr:${RECENCY[recency][0]}` : null;
}

/** Brave's `freshness`: "YYYY-MM-DDtoYYYY-MM-DD" or pd/pw/pm/py; null for neither. */
export function braveFreshness({ before, after, recency } = {}, today = new Date().toISOString().slice(0, 10)) {
  if (before || after) return `${after || EARLIEST}to${before ? dayBefore(before) : today}`;
  return RECENCY[recency] ? RECENCY[recency][1] : null;
}

/** exclude: a string or a list of strings; matched case-insensitively anywhere in a result's URL. */
export function normalizeExclude(exclude) {
  const list = Array.isArray(exclude) ? exclude : exclude == null ? [] : [exclude];
  return list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase());
}

export function isExcluded(url, exclude) {
  const u = String(url || '').toLowerCase();
  return exclude.some((x) => u.includes(x));
}

/** A day inside the range? before = strictly earlier than that day; after = on or after it. */
export function inRange(day, { before, after } = {}) {
  if (!day) return false;
  if (before && !(day < before)) return false;
  if (after && day < after) return false;
  return true;
}

// ---- 1. the page's own publish date -------------------------------------------------------------
const DATE_META = new Set(['article:published_time', 'og:published_time', 'datepublished', 'date', 'pubdate', 'publishdate',
  'publish-date', 'publish_date', 'publication_date', 'dc.date', 'dc.date.issued', 'dcterms.date', 'dcterms.issued',
  'citation_publication_date', 'citation_date', 'parsely-pub-date', 'sailthru.date']);

function toDay(value, today = new Date().toISOString().slice(0, 10)) {
  const s = String(value || '').trim();
  let day = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  if (!day) { const t = Date.parse(s); if (!Number.isNaN(t)) day = new Date(t).toISOString().slice(0, 10); }
  if (!day || day < '1990-01-01' || day > today) return null;
  return parseDayOrNull(day);
}
function parseDayOrNull(day) { try { return parseDay(day, 'date'); } catch { return null; } }

/** The publish date a page states about itself in its HTML, or null. Reads meta tags, then JSON-LD. */
export function publishedDateFromHtml(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4];
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (DATE_META.has(key)) { const d = toDay(attrs.content); if (d) return d; }
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ld) { const d = toDay(ld[1]); if (d) return d; }
  const item = html.match(/itemprop\s*=\s*["']datePublished["'][^>]*?(?:content|datetime)\s*=\s*["']([^"']+)["']/i);
  if (item) { const d = toDay(item[1]); if (d) return d; }
  return null;
}

/** Fetch the start of a page (SSRF-safe, at most ~300 KB, HTML only) and read its publish date; null if none. */
async function pageDateDefault(url, timeoutMs) {
  const { res } = await safeFetch(url, { timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
  if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) { try { await res.body?.cancel(); } catch {} return null; }
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  while (size < 300000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
  try { await reader.cancel(); } catch {}
  return publishedDateFromHtml(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
}
let pageDate = pageDateDefault;
/** Tests only: replace how a page's date is read. */
export function __setPageDate(fn) { pageDate = fn || pageDateDefault; }

// ---- 2. the Internet Archive's first copy, rationed ---------------------------------------------
export const ARCHIVE_PER_MIN = 10;
const ARCHIVE_COOLDOWN_MS = 30 * 60 * 1000;
const archive = { recent: [], blockedUntil: 0 };
const firstSeenCache = new TtlCache({ max: 2000, ttlMs: 24 * 3600 * 1000 });
/** Tests only. */
export function __resetArchiveGate() { archive.recent = []; archive.blockedUntil = 0; }

function archiveSlot(now = Date.now()) {
  if (now < archive.blockedUntil) return false;
  archive.recent = archive.recent.filter((t) => now - t < 60000);
  if (archive.recent.length >= ARCHIVE_PER_MIN) return false;
  archive.recent.push(now);
  return true;
}

/** 'YYYY-MM-DD' the Archive first saved this URL, null if never, or 'unavailable' (rationed out / refused). */
export async function waybackFirstSeen(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const key = String(url).replace(/#.*$/, '');
  const hit = firstSeenCache.get(key);
  if (hit !== undefined) return hit;
  if (!archiveSlot()) return 'unavailable';
  let r;
  try {
    r = await fetchImpl(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(key)}&limit=1&output=json&fl=timestamp`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') archive.blockedUntil = Date.now() + ARCHIVE_COOLDOWN_MS;   // refused, reset: back off
    return 'unavailable';
  }
  if (r.status === 429 || r.status === 403) { archive.blockedUntil = Date.now() + ARCHIVE_COOLDOWN_MS; return 'unavailable'; }
  if (!r.ok) return 'unavailable';
  const text = await r.text();
  let rows = [];
  try { rows = text.trim() ? JSON.parse(text) : []; } catch { return 'unavailable'; }
  const ts = Array.isArray(rows) && Array.isArray(rows[1]) ? String(rows[1][0] || '') : '';
  const day = /^\d{8}/.test(ts) ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null;
  firstSeenCache.set(key, day);
  return day;
}

/**
 * Keep the results whose date is in the range, in their original order, up to `limit`. Each result's date is
 * its own publish date, else the Archive's first copy. Every result looked at is accounted for: kept, outside
 * the range, no date found, or not checked (out of time, or the Archive rationed out). Stops looking once the
 * top results already give `limit` kept.
 */
export async function keepByDate(results, { before, after, limit, budgetMs = 10000, concurrency = 6, fetchImpl } = {}) {
  const deadline = Date.now() + budgetMs;
  const verdicts = new Array(results.length);
  let next = 0;
  // Enough: the first `limit` kept results are settled with nothing pending above them (later ones don't matter).
  const enough = () => {
    if (limit == null) return false;
    let k = 0;
    for (let j = 0; j < next; j++) {
      if (!verdicts[j]) return false;
      if (verdicts[j].keep && ++k >= limit) return true;
    }
    return false;
  };
  const judge = (day, source) => (inRange(day, { before, after }) ? { keep: true, day, source } : { why: 'outside', day, source });
  async function worker() {
    while (next < results.length && !enough()) {
      const i = next++;
      const left = () => deadline - Date.now();
      if (left() < 500) { verdicts[i] = { why: 'not_checked' }; continue; }
      let day = null;
      try { day = await pageDate(results[i].url, Math.min(5000, left())); } catch { day = null; }
      if (day) { verdicts[i] = judge(day, 'page'); continue; }
      if (left() < 500) { verdicts[i] = { why: 'not_checked' }; continue; }
      const seen = await waybackFirstSeen(results[i].url, { fetchImpl, timeoutMs: Math.min(8000, left()) });
      verdicts[i] = seen === 'unavailable' ? { why: 'not_checked' } : seen == null ? { why: 'no_date' } : judge(seen, 'archive');
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, worker));
  const kept = [];
  const counts = { checked: verdicts.filter(Boolean).length, outside_range: 0, no_date: 0, not_checked: 0 };
  results.forEach((r, i) => {
    const v = verdicts[i];
    if (!v) return;   // not needed: enough results above it were already in range
    if (v.keep) kept.push({ ...r, date: v.day, date_source: v.source === 'page' ? 'page publish date' : 'first archived copy' });
    else if (v.why === 'outside') counts.outside_range++;
    else if (v.why === 'no_date') counts.no_date++;
    else counts.not_checked++;
  });
  // In range but past `limit`: checked in parallel with the ones kept, not needed. Counted so the numbers add up.
  const more_in_range = limit == null ? 0 : Math.max(0, kept.length - limit);
  return { kept: kept.slice(0, limit), ...counts, more_in_range };
}
