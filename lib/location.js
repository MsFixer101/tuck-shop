// get_location (k-0696, her 13 Nov 2026: "You can do location via IP address (internet)"): roughly where the user is,
// from the internet connection this machine is on. The public IP comes from a "what is my IP" echo (the only outside
// request, and it carries nothing but the request itself); the IP -> town lookup is a local database, so the IP is
// never sent to a geolocation service. The IP itself is never returned: answers built on this become training data.
//
// Database: DB-IP IP to City Lite (CC-BY 4.0, monthly), data/dbip-city-lite-YYYY-MM.mmdb; the newest file wins, or
// GEOIP_DB names one. Attribution travels with every result.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import maxmind from 'maxmind';
import { TtlCache } from './cache.js';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const IP_ECHO = process.env.IP_ECHO_URL || 'https://api.ipify.org?format=json';
const ipCache = new TtlCache({ max: 1, ttlMs: 10 * 60 * 1000 });   // the home IP rarely changes
let readerP = null, readerPath = null;   // the in-flight or settled open, so concurrent first calls share one
let ipP = null;                          // in-flight IP echo, shared the same way

export function geoDbPath() {
  if (process.env.GEOIP_DB) return process.env.GEOIP_DB;
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => /^dbip-city-lite-\d{4}-\d{2}\.mmdb$/.test(f)).sort(); } catch {}
  return files.length ? path.join(DATA_DIR, files[files.length - 1]) : null;
}

function openReader() {
  const p = geoDbPath();
  if (!p) return Promise.reject(new Error('no geo-IP database (data/dbip-city-lite-YYYY-MM.mmdb)'));
  if (readerP && readerPath === p) return readerP;
  readerPath = p;
  // Messages never carry the path (it names the home folder).
  const opening = maxmind.open(p).catch(() => {
    if (readerP === opening) readerP = null;   // never clear a newer open (a new monthly file dropped in meanwhile)
    throw new Error('the geo-IP database could not be opened');
  });
  readerP = opening;
  return opening;
}

function publicIp() {
  const hit = ipCache.get('ip');
  if (hit) return Promise.resolve(hit);
  if (ipP) return ipP;
  ipP = (async () => {
    const r = await fetch(IP_ECHO, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`IP echo returned ${r.status}`);
    let ip;
    try { ({ ip } = await r.json()); } catch { throw new Error('IP echo did not return JSON'); }   // never echo the body
    if (typeof ip !== 'string' || !maxmind.validate(ip)) throw new Error('IP echo gave no usable address');
    ipCache.set('ip', ip);
    return ip;
  })().finally(() => { ipP = null; });
  return ipP;
}

const en = (o) => o?.names?.en || null;

// Pure: a DB-IP record -> what the model sees. Exported for tests.
export function shapeLocation(rec, dbFile) {
  if (!rec) return null;
  const city = en(rec.city);
  const region = en(rec.subdivisions?.[0]);
  const country = en(rec.country);
  const round = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);   // ~1 km; it's town-level anyway
  return {
    city, region, country,
    country_code: rec.country?.iso_code || null,
    latitude: round(rec.location?.latitude),
    longitude: round(rec.location?.longitude),
    timezone: rec.location?.time_zone || null,
    summary: [city, region, country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    source: 'ip',
    accuracy: 'approximate: the town the internet connection is registered to, not a precise position',
    note: "This is where the computer running the assistant is connected, usually the user's home. If they're out, or it looks wrong, ask.",
    attribution: 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0',
    database: dbFile ? path.basename(dbFile) : null,
  };
}

export async function getLocation() {
  try {
    const dbPath = geoDbPath();
    const [db, ip] = await Promise.all([openReader(), publicIp()]);
    const shaped = shapeLocation(db.get(ip), dbPath);
    if (!shaped || !shaped.country) return { error: 'location not found for this connection' };
    return { result: shaped };
  } catch (err) {
    return { error: `location check failed: ${err.message}` };
  }
}
