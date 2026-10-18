# Actions log — 2026-09-28

## MCP bridge for Grok CLI (Claude, Opus 5.5)
- **Why:** Christina's ask was to add Grok (SuperGrok subscription, Grok Build CLI) to Idea Basin's WhatsApp crew and give it web access through Tuck Shop, not Grok's own tools.
- **Built:** `mcp.js` is a stdio MCP server that proxies `GET /tools` and `POST /tool/:name` to the running service. The service is unchanged and was not restarted. New dependency `@modelcontextprotocol/sdk@^1.27.1`; puppeteer-core is still 24.40.0 and a linkedom parse was checked after the install. README gains an "As an MCP server" section.
- **Registered in Grok:** `grok mcp add tuckshop /opt/homebrew/bin/node -- ~/tuck-shop/mcp.js` plus `[permission] allow = ["MCPTool(tuckshop__*)"]` in `~/.grok/config.toml` (backup `config.toml.bak-20260928`).
- **Tested:** SDK stdio client listed 40 tools; `web_search` returned SearXNG results; `convert_currency` gave 100 GBP = 132.53 USD. Through Model Service's `grok-cli` provider, Grok answered "latest Starship news" with today's launch details without being told to use tools.
- **PR #1** (`feat/mcp-bridge`) is open. My merge was blocked by the Claude Code safety check (no merge without review), so it's waiting on her. **Trap:** until it merges, `~/tuck-shop` must stay on `feat/mcp-bridge`, because Grok's config points at `mcp.js` in the working tree.
