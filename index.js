// Tuck Shop — the ecosystem's shared capability counter. Apps pop round to grab
// a generic tool (web search, fetch, papers, FX) off the shelf. Zero-dependency
// Node http server. Contract: POST /tool/:name {args} → {result} | {error}.
import http from 'node:http';
import { CAPABILITIES } from './capabilities.js';

const PORT = Number(process.env.PORT) || 3455;
const HOST = process.env.HOST || '127.0.0.1'; // localhost-only

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, service: 'tuck-shop', tools: Object.keys(CAPABILITIES).length });
  }

  if (req.method === 'GET' && path === '/tools') {
    return send(res, 200, Object.entries(CAPABILITIES).map(([name, c]) => ({ name, description: c.description, args: c.args })));
  }

  if (req.method === 'POST' && path.startsWith('/tool/')) {
    const name = decodeURIComponent(path.slice('/tool/'.length));
    const cap = CAPABILITIES[name];
    if (!cap) return send(res, 404, { error: `Unknown tool: ${name}` });
    const body = await readBody(req);
    if (body === null) return send(res, 400, { error: 'Invalid JSON body' });
    try {
      const out = await cap.handler(body.args || body || {});
      return send(res, 200, out);
    } catch (err) {
      return send(res, 200, { error: `Tool execution failed: ${err.message}` });
    }
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[tuck-shop] open for business on http://${HOST}:${PORT} — ${Object.keys(CAPABILITIES).length} tools on the shelf`);
});
