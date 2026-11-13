import { test } from 'node:test';
import assert from 'node:assert/strict';
import maxmind from 'maxmind';
import { shapeLocation, geoDbPath } from '../lib/location.js';

test('shapeLocation keeps the town, drops nothing it needs, never carries an IP', () => {
  const rec = { city: { names: { en: 'Leeds' } }, subdivisions: [{ names: { en: 'England' } }],
    country: { iso_code: 'GB', names: { en: 'United Kingdom' } }, location: { latitude: 53.79648, longitude: -1.54785 } };
  const s = shapeLocation(rec, '/x/data/dbip-city-lite-2026-11.mmdb');
  assert.equal(s.summary, 'Leeds, England, United Kingdom');
  assert.equal(s.latitude, 53.8); assert.equal(s.longitude, -1.55);
  assert.equal(s.source, 'ip'); assert.match(s.attribution, /DB-IP/);
  assert.equal(s.database, 'dbip-city-lite-2026-11.mmdb');
  assert.ok(!JSON.stringify(s).match(/\b\d{1,3}(\.\d{1,3}){3}\b/), 'no IPv4 address in the result');
  assert.equal(shapeLocation(null), null);
});

test('summary drops repeats and blanks', () => {
  const s = shapeLocation({ city: { names: { en: 'Singapore' } }, country: { iso_code: 'SG', names: { en: 'Singapore' } }, location: {} });
  assert.equal(s.summary, 'Singapore'); assert.equal(s.latitude, null);
});

test('the local database answers for a public address (no network)', { skip: !geoDbPath() && 'no database file' }, async () => {
  const db = await maxmind.open(geoDbPath());
  const s = shapeLocation(db.get('8.8.8.8'), geoDbPath());
  assert.equal(s.country_code, 'US');
});

test('a missing database gives an error without the path, and never throws', async () => {
  const prev = process.env.GEOIP_DB, prevEcho = process.env.IP_ECHO_URL;
  process.env.GEOIP_DB = '/nonexistent/secret-folder/geo.mmdb';
  process.env.IP_ECHO_URL = 'http://127.0.0.1:9/';   // nothing listens: no outside request from the test
  try {
    const { getLocation } = await import('../lib/location.js?missing=' + Date.now());
    const r = await getLocation();
    assert.ok(r.error, 'returns {error}');
    assert.ok(!r.error.includes('secret-folder'), 'no path in the message');
  } finally {
    if (prev === undefined) delete process.env.GEOIP_DB; else process.env.GEOIP_DB = prev;
    if (prevEcho === undefined) delete process.env.IP_ECHO_URL; else process.env.IP_ECHO_URL = prevEcho;
  }
});
