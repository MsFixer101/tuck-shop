// Headless-Chrome JS renderer for fetch_url SPA fallback. Lazy singleton
// browser, width-2 semaphore, SSRF-guarded request interception.
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { assertPublicHost, isPrivateIp } from './ssrf.js';

// ---- constants ----
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHROME_PATH = process.env.CHROME_PATH ||
  path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.153/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const IDLE_CLOSE_MS = 90_000;
const SEMAPHORE_WIDTH = 2;
const ACQUIRE_TIMEOUT_MS = 2000;

// ---- RenderBusyError ----
export class RenderBusyError extends Error {
  constructor(msg = 'Render busy') { super(msg); this.name = 'RenderBusyError'; }
}

// ---- browser singleton ----
let browserPromise = null;
let idleTimer = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      pipe: true, // chrome dies with the node process even on kill -9 — orphan guard for launchd
      headless: true,
      args: ['--disable-gpu', '--hide-scrollbars', '--mute-audio'],
    });
    browser.on('disconnected', () => { browserPromise = null; });
    return browser;
  })();
  // If launch fails, clear so next call retries.
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    const p = browserPromise; browserPromise = null;
    if (p) { try { (await p).close(); } catch {} }
  }, IDLE_CLOSE_MS).unref();
}

export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const p = browserPromise; browserPromise = null;
  if (p) { try { (await p).close(); } catch {} }
}

// ---- width-2 semaphore with bounded acquire ----
let active = 0;
const waiters = [];

function acquire() {
  return new Promise((resolve, reject) => {
    if (active < SEMAPHORE_WIDTH) { active++; resolve(); return; }
    const t = setTimeout(() => {
      const i = waiters.findIndex(w => w.resolve === resolve);
      if (i >= 0) waiters.splice(i, 1);
      reject(new RenderBusyError('Render busy: no slot within timeout'));
    }, ACQUIRE_TIMEOUT_MS);
    waiters.push({ resolve, t });
  });
}

function release() {
  const next = waiters.shift();
  if (next) { clearTimeout(next.t); next.resolve(); }
  else { active--; }
}

// ---- SSRF interception ----
function isLocalishHost(h) {
  const l = h.toLowerCase();
  return l === 'localhost' || l.endsWith('.local') || l.endsWith('.internal');
}

function makeInterceptHandler(dnsCache) {
  return async (req) => {
    try {
      const u = new URL(req.url());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return req.abort().catch(() => {});
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return req.abort().catch(() => {});
      const host = u.hostname;
      if (isLocalishHost(host)) return req.abort().catch(() => {});
      if (net.isIP(host)) {
        if (isPrivateIp(host)) return req.abort().catch(() => {});
        return req.continue().catch(() => {});
      }
      // Known residual DNS-rebinding TOCTOU accepted (single-user localhost service).
      let addrs = dnsCache.get(host);
      if (!addrs) {
        try { addrs = await dns.lookup(host, { all: true }); } catch { addrs = []; }
        dnsCache.set(host, addrs);
      }
      for (const { address } of addrs) { if (isPrivateIp(address)) return req.abort().catch(() => {}); }
      return req.continue().catch(() => {});
    } catch {
      req.abort().catch(() => {});
    }
  };
}

// ---- renderPage ----
export async function renderPage(url, { budgetMs = 12000, userAgent = DEFAULT_UA } = {}) {
  // Pre-flight SSRF check before touching the browser.
  await assertPublicHost(new URL(url).hostname);

  let acquired = false;
  try {
    await acquire();
    acquired = true;

    const browser = await getBrowser();
    const page = await browser.newPage();
    const dnsCache = new Map();

    let watchdogTimer;
    try {
      const watchdog = new Promise((_, reject) => {
        watchdogTimer = setTimeout(() => reject(new Error('Render timed out')), budgetMs);
      });

      const work = (async () => {
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(userAgent);
        page.on('dialog', d => d.dismiss().catch(() => {}));
        await page.setRequestInterception(true);
        page.on('request', makeInterceptHandler(dnsCache));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
        const html = await page.content();
        const finalUrl = page.url();
        return { html, finalUrl };
      })();

      const result = await Promise.race([work, watchdog]);
      scheduleIdleClose();
      return result;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try { await page.close(); } catch {}
    }
  } finally {
    if (acquired) release();
  }
}
