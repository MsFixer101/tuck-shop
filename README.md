# Tuck Shop 🏪

The ecosystem's shared **capability counter**. Apps pop round to grab a generic tool off the shelf — web search, URL fetch, paper search, currency — instead of each keeping its own forked copy. Plain Node `http` server (deps: Readability, linkedom, puppeteer-core), localhost-only, launchd-supervised.

- **Port:** `127.0.0.1:3455` · **Supervised by:** launchd `com.christina.tuck-shop` (`kill` = respawn) · **Log:** `~/logs/tuck-shop.log`
- **Backends:** SearXNG (`:3465`) for search; Vector Hub (`:3450`, scopes `tuck-shop`→`memoria`) for API keys. Without Vector Hub, keys fall back to `<NAME>_API_KEY` env vars (see `lib/key-store.js`).

## API
- `GET /health` → `{ ok, service, tools }`
- `GET /tools` → `[{ name, description, args }]` (the canonical tool definitions)
- `POST /tool/:name` with `{ "args": { … } }` → `{ result }` | `{ error }`

## Capabilities
| tool | what it does |
|---|---|
| `web_search` | SearXNG → Serper → Brave. `{query, limit?}` |
| `fetch_url` | SSRF-safe, PDF-aware readable fetch (Readability extraction). Per-platform readers for X/Twitter, YouTube, TikTok, Instagram (best-effort), GitHub, Reddit, Hacker News; JS-rendered SPAs rendered automatically via headless Chrome; Wayback fallback on 403/404/410/451; 5-min result cache; arXiv PDFs auto-redirect to the abstract. `{url, mode?: text\|links\|both, render?, offset?, max_chars?}` |
| `search_papers` | Multi-source: HF + arXiv + Semantic Scholar (merged, de-duped). `{query, source?, limit?}` |
| `search_models` / `search_datasets` | Hugging Face. `{query, limit?}` |
| `convert_currency` | Live FX (frankfurter.app, no key). `{amount, from, to}` |

### Cognitive tools (optional, 34 more)
`cognitive.js` bridges the calculator / datetime / probability / statistics / units / thesaurus toolkits from the Train Tracks tools package (`TT_TOOLS_PATH` env var, or the default path in `cognitive.js`) so the same tools a model sees at training time exist at runtime. If the package isn't present, Tuck Shop boots with the six core tools and logs a warning. `GET /tools` adds a `schema` (JSON Schema) field for these.

## Security
`fetch_url` is the whole ecosystem's fetch proxy, so `lib/ssrf.js` resolves the hostname to IPs and refuses private/reserved ranges (loopback, RFC-1918, link-local/metadata, CGNAT/Tailscale, IPv6 ULA), and **re-validates on every redirect hop**. Known-good backend hosts (SearXNG, Serper, etc.) use plain `fetch`; only user/model-supplied URLs go through `safeFetch`.

## Consuming it (from another app)
```js
async function callCapability(name, args) {
  const r = await fetch(`http://127.0.0.1:3455/tool/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }), signal: AbortSignal.timeout(8000),
  });
  return r.json(); // { result } | { error }
}
```
If Tuck Shop is down, `callCapability` should return `{ error }` fast (short timeout) so the caller degrades cleanly.

## Consumer contract
The `fetch_url` result fields `content`, `readable`, `platform`, `url`, `chars`, `truncated` are frozen — consumers flatten on them. New fields are additive only.
