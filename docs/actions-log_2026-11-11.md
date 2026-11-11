# Actions log, 11 Nov 2026

## k-0657: fetch_url says when a page was published (branch wip/k-0657-published)
- For the blog workbench in Train Tracks: a page fetched for a post must have existed before the post's date, so fetch_url now returns `published: 'YYYY-MM-DD'` when the page states its own publish date. It reuses `publishedDateFromHtml` (lib/search-dates.js), the reader behind web_search's dated filter. Additive only: absent when the page has no date, so old outputs are unchanged.
- Checked on a test instance (port 3489, not the live service): her post "When Safety Features Become Safety Hazards…" → 2025-09-01; Anthropic's "Effective context engineering for AI agents" → 2025-09-29; example.com → no field.
- Tests: `node --test test/` 14 pass (new test/fetch-published.test.mjs); removing the field fails one. Test-only hook `__pageResult` builds a result from HTML without fetching.
- Live after merge to trunk and a Tuck Shop restart. Eve sees the new field in Memoria too (same tool).
