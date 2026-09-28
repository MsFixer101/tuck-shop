#!/usr/bin/env node
// Stdio MCP bridge: exposes every Tuck Shop tool to MCP clients (Grok CLI, Codex, …)
// by proxying to the running service's `POST /tool/:name`. Separate process — the
// service itself is untouched. Point TUCK_SHOP_URL elsewhere if not on :3455.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.TUCK_SHOP_URL || 'http://127.0.0.1:3455';

// Tuck Shop describes args loosely: 'string', 'number?', 'day|week|month|year?', 'array', …
function toSchema(args = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(args)) {
    const optional = spec.endsWith('?');
    const t = spec.replace(/\?$/, '');
    if (t === 'number' || t === 'boolean') properties[key] = { type: t };
    else if (t === 'array') properties[key] = { type: 'array', items: {} };
    else if (t.includes('|')) properties[key] = { type: 'string', enum: t.split('|') };
    else properties[key] = { type: 'string' };
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

const server = new Server({ name: 'tuck-shop', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await (await fetch(`${BASE}/tools`)).json();
  return {
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: toSchema(t.args) })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const res = await fetch(`${BASE}/tool/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json();
    if (body.error) return { content: [{ type: 'text', text: String(body.error) }], isError: true };
    const out = typeof body.result === 'string' ? body.result : JSON.stringify(body.result, null, 2);
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Tuck Shop unreachable at ${BASE}: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
