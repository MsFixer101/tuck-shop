# Actions log, 11 Nov 2026

## k-0657: fetch_url says when a page was published (branch wip/k-0657-published)
- For the blog workbench in Train Tracks: a page fetched for a post must have existed before the post's date, so fetch_url now returns `published: 'YYYY-MM-DD'` when the page states its own publish date. It reuses `publishedDateFromHtml` (lib/search-dates.js), the reader behind web_search's dated filter. Additive only: absent when the page has no date, so old outputs are unchanged.
- Checked on a test instance (port 3489, not the live service): her post "When Safety Features Become Safety Hazards…" → 2025-09-01; Anthropic's "Effective context engineering for AI agents" → 2025-09-29; example.com → no field.
- Tests: `node --test test/` 14 pass (new test/fetch-published.test.mjs); removing the field fails one. Test-only hook `__pageResult` builds a result from HTML without fetching.
- Live after merge to trunk and a Tuck Shop restart. Eve sees the new field in Memoria too (same tool).

## k-0657: fetch_url with a date limit (after the independent check failed the workbench, same branch)
- The verifier showed the workbench's Fetch page let through pages with no stated date, feeds (her RSS feed holds her later posts in full) and the Archive's fallback copies, and that the dated sub-agent's fetch_url had no date check at all.
- Fix, in one place for both: fetch_url takes optional `before` and `exclude` (additive; without them nothing changes). With `before`, a page is dated by its own date, else an X post's date, else the Internet Archive's first copy (the same rationed lookup web_search uses); an Archive fallback copy must itself be from before the day; feeds and undated front/listing pages (path one level deep or less) are refused. Refusals are errors marked `refused: 'date' | 'excluded'`; a success gains `date_check: {before, day, source}`.
- Known limit: a page dated before the day is still read as it is today.
- Tests: `node --test test/` 22 pass (new test/fetch-dated.test.mjs, plain fetch and Archive lookup stubbed); turning off the archive, listing, feed or undated rule each fails a test.
- Real pages, before 2026-08-18: her rss.xml, /blog and "Open Loop" (5 Sep 2026) refused; the post itself refused as excluded; a GitHub repo passed on its first archived copy (2025-05-07); Anthropic's many-shot page (2024-04-02) and arXiv 2602.03664 (2026-02-03) passed on their own dates.
