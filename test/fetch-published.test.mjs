// k-0657: fetch_url says when a page was published, when the page states it. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __pageResult } from '../capabilities.js';

const page = (head) => `<html><head><title>T</title>${head}</head><body><article><p>${'Words about a thing. '.repeat(40)}</p></article></body></html>`;

test('a page that states its publish date gets published: YYYY-MM-DD', () => {
  const ld = __pageResult('https://a.example/post', page('<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2025-09-01T10:00:00Z"}</script>'));
  assert.equal(ld.published, '2025-09-01');
  const meta = __pageResult('https://a.example/post', page('<meta property="article:published_time" content="2024-03-05">'));
  assert.equal(meta.published, '2024-03-05');
});

test('no stated date: no published field at all (old outputs unchanged)', () => {
  const r = __pageResult('https://a.example/plain', page(''));
  assert.equal('published' in r, false);
  assert.equal(r.readable, true);
});
