# Tuck Shop 🏪

The ecosystem's shared **capability counter**. Apps pop round to grab a generic tool off the shelf — web search, URL fetch, paper search, currency — instead of each keeping its own forked copy. Zero-dependency Node (`http`), localhost-only, launchd-supervised.

- **Port:** `127.0.0.1:3455` · **Supervised by:** launchd `com.christina.tuck-shop` (`kill` = respawn) · **Log:** `~/logs/tuck-shop.log`
- **Backends:** SearXNG (`:3465`) for search; Vector Hub (`:3450`, scopes `tuck-shop`→`memoria`) for API keys.

## API
- `GET /health` → `{ ok, service, tools }`
- `GET /tools` → `[{ name, description, args }]` (the canonical tool definitions)
- `POST /tool/:name` with `{ "args": { … } }` → `{ result }` | `{ error }`

## Capabilities
| tool | what it does |
|---|---|
| `web_search` | SearXNG → Serper → Brave. `{query, limit?}` |
| `fetch_url` | SSRF-safe, PDF-aware readable fetch. Handles X/Twitter, YouTube, TikTok, (best-effort) Instagram via per-platform readers; arXiv PDFs auto-redirect to the abstract; `mode: text\|links\|both`. `{url, mode?}` |
| `search_papers` | Multi-source: HF + arXiv + Semantic Scholar (merged, de-duped). `{query, source?, limit?}` |
| `search_models` / `search_datasets` | Hugging Face. `{query, limit?}` |
| `convert_currency` | Live FX (frankfurter.app, no key). `{amount, from, to}` |

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

## Not yet migrated
Memoria and Idea Basin still run their own local copies of these tools. Phases 2–3 of the plan (`~/.claude/plans/melodic-snuggling-pine.md`) point them at Tuck Shop and delete the dupes.
