// Article-quality extraction: Readability (via linkedom) with a tag-strip fallback guard.
// Readability is article-tuned and guts list/index/SPA pages as "boilerplate", so we
// fall back to a plain tag-strip whenever Readability's text is suspiciously thin.
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

// Shared tag-strip for plain and rendered HTML (single-space flattening).
export function stripHtml(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function metaContent(document, selector) {
  const el = document.querySelector(selector);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

// Collect metadata BEFORE Readability mutates the DOM. All optional; empty omitted.
function collectMeta(document, url) {
  const meta = {};

  const ogTitle = metaContent(document, 'meta[property="og:title"]');
  const docTitle = (document.querySelector('title')?.textContent || '').trim();
  const title = ogTitle || docTitle;
  if (title) meta.title = title;

  const ogDesc = metaContent(document, 'meta[property="og:description"]');
  const metaDesc = metaContent(document, 'meta[name="description"]');
  const og_description = ogDesc || metaDesc;
  if (og_description) meta.og_description = og_description;

  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const canonicalHref = canonicalEl ? (canonicalEl.getAttribute('href') || '').trim() : '';
  const ogUrl = metaContent(document, 'meta[property="og:url"]');
  let canonical = '';
  if (canonicalHref) {
    try { canonical = new URL(canonicalHref, url).toString(); } catch { canonical = canonicalHref; }
  } else if (ogUrl) {
    try { canonical = new URL(ogUrl, url).toString(); } catch { canonical = ogUrl; }
  }
  if (canonical) meta.canonical = canonical;

  const site_name = metaContent(document, 'meta[property="og:site_name"]');
  if (site_name) meta.site_name = site_name;

  const author = metaContent(document, 'meta[name="author"]');
  if (author) meta.byline = author;

  return meta;
}

// Preserve paragraph structure: collapse intra-paragraph whitespace to single spaces,
// runs of blank lines to exactly \n\n.
function normalizeReadable(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractContent(html, url) {
  const stripped = stripHtml(html);

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch (e) {
    return { text: stripped, title: '', byline: '', meta: {} };
  }

  const meta = collectMeta(document, url);

  let readableText = '';
  let readableTitle = '';
  let readableByline = '';
  let readableOk = false;
  try {
    const article = new Readability(document).parse();
    if (article && article.textContent) {
      readableText = normalizeReadable(article.textContent);
      readableTitle = (article.title || '').trim();
      readableByline = (article.byline || '').trim();
      readableOk = true;
    }
  } catch (e) {
    // fall through to tag-strip
  }

  let text, title, byline;
  if (readableOk) {
    // Guard: Readability guts list/index/SPA pages. If its text is < 500 chars while
    // the tag-strip is > 2× longer, the page isn't an article — use the tag-strip.
    const tooThin = readableText.length < 500 && stripped.length > readableText.length * 2;
    text = tooThin ? stripped : readableText;
    title = readableTitle || meta.title || '';
    byline = readableByline || meta.byline || '';
  } else {
    text = stripped;
    title = meta.title || '';
    byline = meta.byline || '';
  }

  // meta returned to caller carries only the spread-at-top-level fields
  // (title/byline are returned separately).
  const cleanMeta = {};
  if (meta.og_description) cleanMeta.og_description = meta.og_description;
  if (meta.canonical) cleanMeta.canonical = meta.canonical;
  if (meta.site_name) cleanMeta.site_name = meta.site_name;

  return { text, title, byline, meta: cleanMeta };
}
