// Resolve API keys from Vector Hub. Own scope ('tuck-shop') first, then the
// shared 'memoria' scope (where brave etc. already live), then env fallback.
const VH_URL = process.env.VECTOR_HUB_URL || 'http://localhost:3450';
const VH_TOKEN = process.env.HUB_TOKEN || '';
const SCOPES = ['tuck-shop', 'memoria'];

let cache = null;

async function loadKeys() {
  if (cache) return cache;
  const merged = {};
  for (const scope of SCOPES) {
    try {
      const res = await fetch(`${VH_URL}/api/keys/${scope}`, { headers: { 'X-Hub-Token': VH_TOKEN } });
      if (res.ok) {
        const keys = await res.json();
        for (const [k, v] of Object.entries(keys)) if (!(k in merged)) merged[k] = v;
      } else {
        console.warn(`[key-store] Vector Hub ${scope} returned ${res.status}`);
      }
    } catch (e) {
      console.warn(`[key-store] Vector Hub ${scope} unavailable:`, e.message);
    }
  }
  cache = merged;
  return cache;
}

export async function getKey(name) {
  const keys = await loadKeys();
  return keys[name] || process.env[`${name.toUpperCase()}_API_KEY`] || null;
}

export function clearKeyCache() { cache = null; }
