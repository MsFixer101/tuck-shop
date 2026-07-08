# Actions Log — 2026-07-08 (Tuck Shop — built + adopted)

## What it is
Tuck Shop — the ecosystem's shared **capability service**. Apps call it for generic tools instead of each keeping a forked copy. Born from Memoria's `web_search` failing, which exposed that Memoria and Idea Basin had diverged copies of the tool layer. Christina: *"Making AI online… frictionless. That's why I built Tuck Shop."*

## Built
- `~/tuck-shop`, zero-dependency Node `http`, `127.0.0.1:3455`, launchd `com.christina.tuck-shop` (`kill`=respawn), log `~/logs/tuck-shop.log`.
- Contract: `POST /tool/:name {args}` → `{result}|{error}`; `GET /health`, `/tools`.
- **Capabilities:** `web_search` (SearXNG→Serper→Brave, optional `recency`), `fetch_url` (SSRF-hardened; PDF-aware; readers for X=fxtwitter, YouTube=transcript, TikTok/IG=oEmbed; `mode: text|links|both`), `search_papers` (HF+arXiv+Semantic-Scholar merged), `search_models`/`search_datasets` (HF), `convert_currency` (frankfurter).
- **Keys** via Vector Hub (`lib/key-store.js`, scope `tuck-shop`→`memoria`); Serper provisioned into `tuck-shop` scope.
- **SSRF** (`lib/ssrf.js`): resolves host→IP, blocks private/reserved ranges (loopback, RFC-1918, link-local/metadata, CGNAT, IPv6 ULA), re-validates every redirect hop. Only user/model URLs go through it.
- **YouTube transcript:** pure-Node is blocked (YouTube returns 200/empty), so shell to `python3.11 youtube-transcript-api` (already installed; already used by Basin's WhatsApp bot). Verified 12k chars.

## Verified live
`/health`, `/tools`; `web_search`→searxng; `fetch_url` SSRF-blocks `127.0.0.1`, arXiv PDF→readable, X/YouTube/TikTok readers; `search_papers` multi-source; `convert_currency`; Serper fallback path. launchd respawn confirmed.

## Adopted
Memoria + Idea Basin (chat tools, Basin WhatsApp bot + morning briefing) all route here; Basin's `web-search.js` retired. See each project's `docs/actions-log_2026-07-08.md`.

## Repo
`github.com/MsFixer101/tuck-shop` (**private**, branch `trunk`). Commits: initial · `49aa614` (YouTube transcript) · `56a82d2` (web_search recency). `.env` gitignored.

## Open
- **JS rendering** — `fetch_url` can't run JavaScript; SPAs (30papers.com) return an empty shell. Next: add a `render` mode (Puppeteer+`chrome-headless-shell` recommended; Playwright/Lightpanda alternatives), auto-fallback on thin-HTML+JS-bundle. Christina to pick engine. Handover: `idea-basin-artifacts/handover_tuck-shop_2026-07-08.md`.

---

# Session 2 (later same day) — the web-robustness upgrade

Plan `~/.claude/plans/fluffy-hugging-rose.md` (approved). Pattern: GLM 5.2 implemented every phase from self-contained briefs; Fable checked adversarially and arbitrated by running the code. Four commits, all pushed to `trunk`.

## Phase 1 — JS rendering (`443e847`) — closes the "Open" item above
- `lib/render.js`: puppeteer-core `24.40.0` exact-pinned to the installed chrome-headless-shell 146 binary (no download). Lazy singleton browser, `pipe:true` transport (chrome dies with node even on `kill -9` — verified: 0 orphans, launchd respawned), width-2 semaphore, 90s idle-close (verified: 0 chrome procs after 110s), SSRF request-interception mirroring `safeFetch`'s per-hop checks (verified: `render:true` on `127.0.0.1:3450` and `localhost:3500` both blocked).
- Auto-render heuristic on the default path (thin text + SPA signature): **30papers.com now returns the real paper list, `rendered:true`, in 2.3s** — was 61 chars of shell. Render failure degrades to the un-rendered result + `render_attempted`/`note`, never `{error}` (verified via bogus CHROME_PATH).
- SIGTERM/SIGINT handlers close the browser; SIGTERM mid-render also verified clean.

## Phase 2 — extraction quality (`058c67f`)
- `lib/extract.js`: Readability via linkedom with a fallback guard (tag-strip wins when Readability guts a non-article page). Wikipedia article: was 112k chars starting with nav junk → 81k starting with real prose + `title`.
- `offset`/`max_chars` args — truncation is pageable now. Additive `title`/`byline`/`og_description`/`canonical`/`site_name`.

## Phase 3 — PDFs (`77dcc4d`)
- `lib/pdf.js`: poppler `pdftotext` primary, PyMuPDF fallback, 20MB cap, temp-file hygiene verified. Berkshire 2023 letter → 50k chars real text through the normal paging shape. 404MB IPCC report refused in 0.19s via content-length. arXiv `/pdf/→/abs/` rewrite unchanged.

## Phase 4 — readers, Wayback, cache (`0e6460a`)
- `lib/readers.js`: GitHub (repo → description/stars/README-as-content, optional `github` key via key-store), HN (Algolia), Reddit (.json first — currently 403s for ALL UAs from this network — then falls through to a `old.reddit.com` host rewrite on the generic path; verified real post content).
- Wayback fallback on 403/404/410/451: dead Google Reader URL → 2021 snapshot, `archived:true`.
- `lib/cache.js`: 5-min/100-entry TTL LRU keyed `url|mode|render`, stores full pre-pagination text (offset re-slices from cache, 14ms); failures never cached.
- Reddit/HN results carry flattened `content` so naive consumers (WhatsApp bot reads `.content`) work without knowing the platform shapes.

## Regression evidence
X + YouTube reader outputs byte-identical to pre-upgrade captures; all six tools re-verified; `/health`+`/tools` contract intact. Consumer contract preserved (`content`/`readable`/`platform`/`chars`/`truncated` untouched; all new fields additive; worst-case timing inside the consumers' 25s abort).

## Still open
- **Live WhatsApp verify** — Christina to post a 30papers.com link + any X/YouTube link in the group; `@glm` summary should reference the real papers.
- Blog post about the upgrade (draft only; publish is her call).
