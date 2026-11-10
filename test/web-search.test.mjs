// k-0660: web_search before / after / exclude. The network is stubbed: no search engine, page or archive is called.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, dayBefore, serperTbs, braveFreshness, normalizeExclude, inRange, publishedDateFromHtml,
  __setPageDate, __resetArchiveGate, ARCHIVE_PER_MIN } from '../lib/search-dates.js';
import { CAPABILITIES } from '../capabilities.js';

const search = (args) => CAPABILITIES.web_search.handler(args);
const realFetch = globalThis.fetch;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
let uid = 0;   // archive answers are cached by URL: every test uses its own URLs

/**
 * Stub the network. searx: SearXNG results; pages: url → the page's own publish day (or null); firstSeen: url →
 * archive timestamp; archiveRefuses: the archive refuses the connection. Records every call.
 */
function stub({ searx = [], searxStatus = 200, pages = {}, firstSeen = {}, archiveRefuses = false, serper = null, brave = null } = {}) {
  const calls = [];
  __setPageDate(async (url) => { calls.push({ url: `page:${url}` }); return pages[url] ?? null; });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: opts.body });
    if (u.includes('/api/keys/')) return json({}, 404);
    if (u.startsWith('http://127.0.0.1:3465/search')) return json({ results: searx }, searxStatus);
    if (u.startsWith('https://web.archive.org/cdx/')) {
      if (archiveRefuses) throw new TypeError('fetch failed');
      const ts = firstSeen[decodeURIComponent(new URL(u).searchParams.get('url'))];
      return json(ts === undefined ? [] : [['timestamp'], [ts]]);
    }
    if (u.startsWith('https://google.serper.dev/')) return serper ? json(serper) : json({}, 500);
    if (u.startsWith('https://api.search.brave.com/')) return brave ? json(brave) : json({}, 500);
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}
test.afterEach(() => {
  globalThis.fetch = realFetch; __setPageDate(null); __resetArchiveGate();
  delete process.env.SERPER_API_KEY; delete process.env.BRAVE_API_KEY;
});
const archiveCalls = (calls) => calls.filter((c) => c.url.startsWith('https://web.archive.org/')).length;
const R = (id) => ({ title: `T${id}`, url: `https://example.org/${id}`, content: `S${id}` });
const U = (id) => `https://example.org/${id}`;

test('dates: parsing, the day before, and the range test', () => {
  assert.equal(parseDay('2026-08-18', 'before'), '2026-08-18');
  assert.equal(parseDay(undefined, 'before'), null);
  assert.throws(() => parseDay('2026-8-18', 'before'), /YYYY-MM-DD/);
  assert.throws(() => parseDay('2026-02-30', 'before'), /not a real date/);
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
  assert.equal(inRange('2026-08-17', { before: '2026-08-18' }), true);
  assert.equal(inRange('2026-08-18', { before: '2026-08-18' }), false, 'before is strictly earlier');
  assert.equal(inRange('2026-08-18', { after: '2026-08-18' }), true, 'after includes the day');
  assert.equal(inRange(null, { before: '2026-08-18' }), false);
  assert.deepEqual(normalizeExclude(' ChristinaSouch.com/blog/write-access '), ['christinasouch.com/blog/write-access']);
  assert.deepEqual(normalizeExclude(['a', '', 3, null]), ['a']);
});

test("a page's own publish date: meta tags in either attribute order, JSON-LD, itemprop; nothing invented", () => {
  assert.equal(publishedDateFromHtml('<meta property="article:published_time" content="2025-09-15T08:00:00Z">'), '2025-09-15');
  assert.equal(publishedDateFromHtml('<meta content="2025-09-16" name="date">'), '2025-09-16');
  assert.equal(publishedDateFromHtml('<script type="application/ld+json">{"@type":"Article","datePublished": "2025-09-17T10:00:00+01:00"}</script>'), '2025-09-17');
  assert.equal(publishedDateFromHtml('<time itemprop="datePublished" datetime="2025-09-18">18 Sep</time>'), '2025-09-18');
  assert.equal(publishedDateFromHtml('<meta name="description" content="2025-09-19"><time datetime="2025-09-20">x</time>'), null);
  assert.equal(publishedDateFromHtml('<meta name="date" content="2999-01-01">'), null, 'a future date is not a publish date');
});

test('provider date parameters: Serper tbs and Brave freshness, ranges and recency', () => {
  assert.equal(serperTbs({ before: '2026-08-18' }), 'cdr:1,cd_min:1/1/1995,cd_max:8/17/2026');
  assert.equal(serperTbs({ after: '2025-09-01', before: '2026-08-18' }), 'cdr:1,cd_min:9/1/2025,cd_max:8/17/2026');
  assert.equal(serperTbs({ recency: 'week' }), 'qdr:w');
  assert.equal(serperTbs({}), null);
  assert.equal(braveFreshness({ before: '2026-08-18' }), '1995-01-01to2026-08-17');
  assert.equal(braveFreshness({ after: '2025-09-01' }, '2026-11-10'), '2025-09-01to2026-11-10');
  assert.equal(braveFreshness({ recency: 'month' }), 'pm');
  assert.equal(braveFreshness({}), null);
});

test('a search without the new arguments is exactly as before: same fields, no page or archive lookups', async () => {
  const calls = stub({ searx: [R(1), R(2), R(3)] });
  const out = await search({ query: 'q', limit: 2 });
  assert.deepEqual(Object.keys(out.result).sort(), ['query', 'results', 'source']);
  assert.equal(out.result.source, 'searxng');
  assert.deepEqual(out.result.results, [{ title: 'T1', url: U(1), snippet: 'S1' }, { title: 'T2', url: U(2), snippet: 'S2' }]);
  assert.equal(calls.filter((c) => c.url.startsWith('page:') || c.url.includes('archive.org')).length, 0);
});

test('before: the page date first, the archive only when the page has none; the rest counted by why', async () => {
  const [a, b, c, d, e] = [++uid, ++uid, ++uid, ++uid, ++uid].map((i) => `b${i}`);
  const calls = stub({
    searx: [R(a), R(b), R(c), R(d), R(e)],
    pages: { [U(b)]: '2026-09-01', [U(e)]: '2025-01-05' },                 // b: page says after the date; e: page says before
    firstSeen: { [U(a)]: '20251003032409', [U(e)]: '20260901000000' },     // a: no page date, archived before; c: neither
  });
  const out = await search({ query: 'q', limit: 5, before: '2026-08-18', exclude: [`example.org/${d}`] });
  const r = out.result;
  assert.equal(r.source, 'searxng');
  assert.deepEqual(r.results, [
    { title: `T${a}`, url: U(a), snippet: `S${a}`, date: '2025-10-03', date_source: 'first archived copy' },
    { title: `T${e}`, url: U(e), snippet: `S${e}`, date: '2025-01-05', date_source: 'page publish date' },
  ]);
  assert.deepEqual(r.filter, { before: '2026-08-18', exclude: [`example.org/${d}`], excluded: 1,
    method: "each page's publish date, else its first archived copy (Internet Archive)", checked: 4, outside_range: 1, no_date: 1, not_checked: 0, more_in_range: 0 });
  assert.equal(archiveCalls(calls), 2, 'archive asked only for the two pages without a date of their own');
});

test('after: on or after the date', async () => {
  const [a, b] = [++uid, ++uid].map((i) => `a${i}`);
  stub({ searx: [R(a), R(b)], pages: { [U(a)]: '2026-01-01', [U(b)]: '2025-01-01' } });
  const out = await search({ query: 'q', after: '2026-01-01' });
  assert.deepEqual(out.result.results.map((x) => x.url), [U(a)]);
});

test('nothing in range: an empty answer that says so, not a fall-back to undated results', async () => {
  const a = `n${++uid}`;
  stub({ searx: [R(a)], pages: { [U(a)]: '2026-09-01' } });
  const out = await search({ query: 'q', before: '2026-08-18' });
  assert.equal(out.result.source, 'searxng');
  assert.deepEqual(out.result.results, []);
  assert.match(out.result.note, /before 2026-08-18/);
  assert.equal(out.result.filter.outside_range, 1);
});

test('stops looking once the top results already give enough, keeping them in order', async () => {
  const ids = Array.from({ length: 20 }, () => `s${++uid}`);
  const pages = Object.fromEntries(ids.map((id, i) => [U(id), i === 1 ? '2026-09-01' : '2025-01-01']));
  const calls = stub({ searx: ids.map(R), pages });
  const out = await search({ query: 'q', limit: 2, before: '2026-08-18' });
  assert.deepEqual(out.result.results.map((x) => x.url), [U(ids[0]), U(ids[2])]);
  const looked = calls.filter((c) => c.url.startsWith('page:')).length;
  assert.equal(out.result.filter.checked, looked);
  assert.ok(looked < 20, `looked at ${looked} of 20`);
  const f = out.result.filter;   // every result looked at is accounted for
  assert.equal(out.result.results.length + f.outside_range + f.no_date + f.not_checked + f.more_in_range, f.checked);
});

test(`the archive is rationed: at most ${ARCHIVE_PER_MIN} lookups a minute, the rest "not checked"`, async () => {
  const ids = Array.from({ length: ARCHIVE_PER_MIN + 4 }, () => `r${++uid}`);
  const calls = stub({ searx: ids.map(R), firstSeen: Object.fromEntries(ids.map((id) => [U(id), '20260901000000'])) });
  const out = await search({ query: 'q', limit: 10, before: '2026-08-18' });
  assert.equal(archiveCalls(calls), ARCHIVE_PER_MIN);
  assert.equal(out.result.filter.outside_range, ARCHIVE_PER_MIN);
  assert.equal(out.result.filter.not_checked, 4);
});

test('the archive refusing the connection stops all lookups for a while (no hammering)', async () => {
  const first = [`x${++uid}`, `x${++uid}`];
  let calls = stub({ searx: first.map(R), archiveRefuses: true });
  let out = await search({ query: 'q', before: '2026-08-18' });
  assert.equal(out.result.filter.not_checked, 2);
  const second = [`x${++uid}`];
  calls = stub({ searx: second.map(R), firstSeen: { [U(second[0])]: '20250101000000' } });
  out = await search({ query: 'q', before: '2026-08-18' });
  assert.equal(archiveCalls(calls), 0, 'still backing off');
  assert.equal(out.result.filter.not_checked, 1);
});

test('bad dates are refused with a plain message', async () => {
  stub({});
  assert.match((await search({ query: 'q', before: '18/08/2026' })).error, /YYYY-MM-DD/);
  assert.match((await search({ query: 'q', after: '2026-08-18', before: '2026-08-18' })).error, /after must be earlier/);
});

test('Serper and Brave get the range (and recency) in the request when SearXNG has nothing', async () => {
  process.env.SERPER_API_KEY = 'test';
  let calls = stub({ searxStatus: 500, serper: { organic: [{ title: 'S', link: 'https://s.example/1', snippet: 'x', date: 'Sep 15, 2025' }, { title: 'X', link: 'https://christinasouch.com/blog/write-access', snippet: 'y' }] } });
  let out = await search({ query: 'q', before: '2026-08-18', exclude: 'christinasouch.com/blog/write-access' });
  assert.equal(JSON.parse(calls.find((c) => c.url.startsWith('https://google.serper.dev/')).body).tbs, 'cdr:1,cd_min:1/1/1995,cd_max:8/17/2026');
  assert.deepEqual(out.result.results, [{ title: 'S', url: 'https://s.example/1', snippet: 'x', date: 'Sep 15, 2025' }]);
  assert.equal(out.result.filter.method, 'search engine date range (Serper)');
  assert.equal(out.result.filter.excluded, 1);
  calls = stub({ searxStatus: 500, serper: { organic: [{ title: 'S', link: 'https://s.example/1', snippet: 'x' }] } });
  await search({ query: 'q', recency: 'week' });
  assert.equal(JSON.parse(calls.find((c) => c.url.startsWith('https://google.serper.dev/')).body).tbs, 'qdr:w', 'recency now reaches Serper');
  delete process.env.SERPER_API_KEY;
  process.env.BRAVE_API_KEY = 'test';
  calls = stub({ searxStatus: 500, brave: { web: { results: [{ title: 'B', url: 'https://b.example/1', description: 'd', page_age: '2025-09-15T00:00:00' }] } } });
  out = await search({ query: 'q', before: '2026-08-18' });
  assert.equal(new URL(calls.find((c) => c.url.startsWith('https://api.search.brave.com/')).url).searchParams.get('freshness'), '1995-01-01to2026-08-17');
  assert.equal(out.result.results[0].date, '2025-09-15');
});
