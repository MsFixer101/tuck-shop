// k-0657: fetch_url with a date limit (before / exclude). The plain fetch and the Archive lookup are stubbed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, __setDatedFetchDeps } from '../capabilities.js';

const fetchUrl = (a) => CAPABILITIES.fetch_url.handler(a);
const page = (extra = {}) => ({ result: { url: 'https://a.example/post/one', readable: true, chars: 3, truncated: false, content: 'abc', ...extra } });
afterEach(() => __setDatedFetchDeps({}));

test('no before or exclude: exactly the plain result, nothing added', async () => {
  __setDatedFetchDeps({ plain: async () => page({ published: '2030-01-01' }) });
  assert.deepEqual(await fetchUrl({ url: 'https://a.example/post/one' }), page({ published: '2030-01-01' }));
});

test('a page that states a date before the day passes, with date_check', async () => {
  __setDatedFetchDeps({ plain: async () => page({ published: '2025-02-01' }) });
  const r = (await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).result;
  assert.deepEqual(r.date_check, { before: '2026-08-18', day: '2025-02-01', source: 'page publish date' });
  assert.equal(r.content, 'abc');
});

test('published on or after the day: refused, marked refused', async () => {
  __setDatedFetchDeps({ plain: async () => page({ published: '2026-08-18' }) });
  const out = await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' });
  assert.equal(out.refused, 'date'); assert.match(out.error, /Published 2026-08-18, not before 2026-08-18/); assert.equal(out.result, undefined);
});

test('no stated date: the Archive\'s first copy decides; none or rationed out is refused', async () => {
  __setDatedFetchDeps({ plain: async () => page(), first: async () => '2024-05-01' });
  assert.equal((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).result.date_check.source, 'first archived copy');
  __setDatedFetchDeps({ plain: async () => page(), first: async () => '2026-09-01' });
  assert.match((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).error, /First archived 2026-09-01/);
  __setDatedFetchDeps({ plain: async () => page(), first: async () => null });
  assert.match((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).error, /no archived copy/);
  __setDatedFetchDeps({ plain: async () => page(), first: async () => 'unavailable' });
  assert.equal((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).refused, 'date');
});

test('feeds, and undated front or listing pages, are refused before or after fetching', async () => {
  let fetched = 0;
  __setDatedFetchDeps({ plain: async (a) => { fetched++; return { result: { url: a.url, readable: true, content: 'list' } }; }, first: async () => '2020-01-01' });
  for (const u of ['https://christinasouch.com/rss.xml', 'https://x.example/feed/', 'https://x.example/atom.xml']) assert.equal((await fetchUrl({ url: u, before: '2026-08-18' })).refused, 'date', u);
  assert.equal(fetched, 0, 'feeds are refused without fetching');
  for (const u of ['https://christinasouch.com/blog', 'https://x.example/']) assert.match((await fetchUrl({ url: u, before: '2026-08-18' })).error, /front or listing page/, u);
  assert.ok((await fetchUrl({ url: 'https://github.com/owner/repo', before: '2026-08-18' })).result, 'deeper pages with no date go by the Archive');
});

test("an archived fallback copy must itself be from before the day", async () => {
  __setDatedFetchDeps({ plain: async () => page({ published: '2025-01-01', archived: true, archive_url: 'https://web.archive.org/web/20261001000000/x', archive_date: '20261001000000' }) });
  assert.match((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).error, /copy from 2026-10-01/);
  __setDatedFetchDeps({ plain: async () => page({ published: '2025-01-01', archived: true, archive_date: '20250301000000' }) });
  assert.ok((await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' })).result);
});

test('exclude: refused before fetching, and when the page lands on an excluded address', async () => {
  let fetched = 0;
  __setDatedFetchDeps({ plain: async () => { fetched++; return page({ url: 'https://christinasouch.com/blog/write-access', published: '2025-01-01' }); } });
  assert.equal((await fetchUrl({ url: 'https://CHRISTINASOUCH.com/blog/write-access#x', exclude: ['christinasouch.com/blog/write-access'] })).refused, 'excluded');
  assert.equal(fetched, 0);
  assert.equal((await fetchUrl({ url: 'https://short.example/r', before: '2026-08-18', exclude: ['christinasouch.com/blog/write-access'] })).refused, 'excluded');
});

test('a page that failed to load is reported as it always was (not marked refused)', async () => {
  __setDatedFetchDeps({ plain: async () => ({ error: 'Fetch failed: HTTP 500' }) });
  assert.deepEqual(await fetchUrl({ url: 'https://a.example/post/one', before: '2026-08-18' }), { error: 'Fetch failed: HTTP 500' });
});
