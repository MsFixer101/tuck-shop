# Actions log — 2026-07-17 (Tuck Shop)

## Eve contract Phase 1 (branch `eve-contract-phase1` off trunk, commit a7b71c6 — NOT pushed, service NOT restarted; changes inert until restart)

- New `cognitive.js` — bridges Train Tracks' 34 cognitive tools (calculator/datetime/probability/statistics/thesaurus/units) into `CAPABILITIES` via `createRequire` path import of `~/panel-of-experts/training-tools/train-tracks/tools/index.js`. TT files remain the single source; no copies. Boot-safe guard: missing TT path → warning + original 6 tools only.
- `capabilities.js` — spread of bridge entries (registry now 40 tools, zero name collisions).
- `index.js` — `GET /tools` additively includes a `schema` field (JSON Schema) for cognitive tools; frozen `{name, description, args}` fields unchanged.
- Verified without restart: module loads clean, 40 names, direct handler calls (`calculate`, `date_difference`, `convert_units`) return correct `{result}`/`{error}` shapes. Note: units tool vocabulary uses full names (`miles`, not `mi`).

## Activation (same day, ~17:25, Christina approved)
- Restarted via launchctl kickstart. `/health` → 40 tools. Live calls verified: `calculate` 2+2→4, `convert_units` 100km→62.137119 miles, `web_search` (frozen contract) still returning `{result}`.
- Branch pushed: `origin/eve-contract-phase1` (MsFixer101/tuck-shop).
