# Actions log — 2026-11-10

## k-0660 web_search: before / after a date, and exclude (claude)

Christina: "Yeah, let's fix tuck shop" — for the blog workbench (k-0657), searches built around a finished post must only
return what could have been found before the post's date, with the post itself left out.

- `web_search` takes `before` / `after` (YYYY-MM-DD) and `exclude` (URL parts). Additive: a search without them is
  unchanged (same calls, same fields; tested).
- Live searches run on SearXNG only (Serper / Brave keys aren't reachable since Vector Hub went off), and SearXNG has
  no date range. So a dated SearXNG search checks each result: its own publish date (meta tags, JSON-LD), else the
  day the Internet Archive first saved it. Each kept result says which (`date`, `date_source`); the `filter` block
  counts what was excluded, outside the range, had no date, or wasn't checked.
- The archive is rationed: 10 lookups a minute, none for 30 minutes after it refuses us. Testing without that got this
  network's connections to web.archive.org refused for a while (about 50 lookups in two minutes), which also briefly
  hit fetch_url's archive fallback.
- Serper (`tbs cdr`) and Brave (`freshness`) get the range in the query if their keys come back; `recency`, which
  only SearXNG used before, now reaches them too.
- `lib/search-dates.js`, `test/web-search.test.mjs` (12 tests, `npm test`; three deliberate bugs each caught). Real
  searches on a second copy (port 3557): 5 of 5 results dated before 18 Aug 2026, 3–8 s.
