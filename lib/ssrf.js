// SSRF-safe fetch for the shared fetch_url capability. This is the whole
// ecosystem's fetch proxy, so it must refuse internal targets: resolve the
// hostname to IPs and reject private/reserved ranges, and re-validate on every
// redirect hop (a public URL can 302 to http://127.0.0.1).
import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateIp(ip) {
  const v = ip.replace(/^::ffff:/i, ''); // IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                         // private
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 169 && b === 254) return true;           // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (tailscale range)
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;    // loopback / unspecified
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA
    if (low.startsWith('fe80')) return true;           // link-local
    return false;
  }
  return true; // unparseable → refuse
}

export async function assertPublicHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'metadata.google.internal' || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private/reserved address: ${hostname}`);
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error(`Could not resolve ${hostname}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Blocked: ${hostname} resolves to private address ${address}`);
  }
}

// Fetch with manual redirect handling; each hop is SSRF-checked before the request.
export async function safeFetch(url, { maxRedirects = 5, timeoutMs = 15000, headers = {} } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error(`Invalid URL: ${current}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed');
    await assertPublicHost(u.hostname);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('Too many redirects');
}
