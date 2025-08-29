'use strict';

/**
 * Vercel/Next API kompatibilis utilok:
 * - getRawBody(req) nyers body-hoz (HMAC)
 * - verifyHmac, requireShopAndTopic
 * - Google Sheets singleton kliens
 * - Shopify GraphQL kliens (API ver. normalizálás)
 * - HU dátum/decimális formázók
 * - withRetry, requireEnv, sheetRange
 */

const crypto = require('crypto');
const { google } = require('googleapis');

// ---- Env ellenőrzés (kritikus kulcsok) ----
function requireEnv(keys) {
  const missing = keys.filter(k => !(process.env[k] || '').trim());
  if (missing.length) {
    throw new Error(`Hiányzó környezeti változó(k): ${missing.join(', ')}`);
  }
}
requireEnv(['SHOPIFY_API_SECRET_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY']);

// ---- Nyers body olvasása (Vercel/Next API) ----
async function getRawBody(req) {
  // Ha már buffer
  if (req.body && Buffer.isBuffer(req.body)) return req.body;

  // Next API bodyParser kikapcsolása esetén jellemzően streamet kapunk:
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ---- HMAC ellenőrzés Shopify-hoz ----
function verifyHmac(req, rawBody) {
  const secret = (process.env.SHOPIFY_API_SECRET_KEY || '').trim();
  const received = (req.headers['x-shopify-hmac-sha256'] || '').toString();
  if (!received || !secret) return false;

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'base64');
  const b = Buffer.from(received, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- Shop & Topic guard (opcionális) ----
function requireShopAndTopic(req, expectedTopic) {
  const shopHeader = (req.headers['x-shopify-shop-domain'] || '').toString();
  const topicHeader = (req.headers['x-shopify-topic'] || '').toString();
  const expectedShop = (process.env.SHOPIFY_SHOP_NAME || '').trim();

  if (expectedShop && shopHeader && shopHeader !== `${expectedShop}.myshopify.com`) {
    const err = new Error(`Ismeretlen shop domain: ${shopHeader}`);
    err.status = 400;
    throw err;
  }
  if (expectedTopic && topicHeader && topicHeader !== expectedTopic) {
    const err = new Error(`Nem várt webhook topic: ${topicHeader} (várt: ${expectedTopic})`);
    err.status = 400;
    throw err;
  }
}

// ---- Google Private Key normalizálás ----
function normalizeGooglePrivateKey(raw) {
  let key = (raw || '').trim();
  if (!key) return key;
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  if (!/BEGIN PRIVATE KEY/.test(key)) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n`;
  }
  return key;
}

// ---- Google Sheets kliens (singleton) ----
let _sheets = null;
async function getSheets() {
  if (_sheets) return _sheets;
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: normalizeGooglePrivateKey(process.env.GOOGLE_PRIVATE_KEY || ''),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: client });
  return _sheets;
}

// ---- Shopify API version normalizálás ('2025.04.01' -> '2025-04') ----
function normalizeShopifyApiVersion(verRaw) {
  const v = (verRaw || '').trim();
  if (!v) return v;
  const m = v.match(/(\d{4})[.\-_/]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  return v;
}

// ---- Fetch (Node18+ globális, különben node-fetch) ----
const doFetch = (...args) =>
  (typeof fetch !== 'undefined'
    ? fetch(...args)
    : import('node-fetch').then(m => m.default(...args)));

// ---- Shopify GraphQL kliens ----
function createShopifyGraphQL() {
  const shop = (process.env.SHOPIFY_SHOP_NAME || '').trim();
  const token = (process.env.SHOPIFY_API_ACCESS_TOKEN || '').trim();
  const ver = normalizeShopifyApiVersion(process.env.SHOPIFY_API_VERSION || '');

  if (!shop || !token || !ver) {
    return async function _noopGQL() {
      throw new Error('Shopify GraphQL nincs bekonfigurálva (SHOPIFY_SHOP_NAME / SHOPIFY_API_ACCESS_TOKEN / SHOPIFY_API_VERSION).');
    };
  }
  const url = `https://${shop}.myshopify.com/admin/api/${ver}/graphql.json`;

  return async function gql(query, variables = {}) {
    const resp = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.errors) {
      const msg = JSON.stringify(json.errors || json, null, 2);
      const err = new Error(`Shopify GraphQL hiba: ${msg}`);
      err.status = resp.status;
      throw err;
    }
    return json.data;
  };
}
const shopifyGQL = createShopifyGraphQL();

// ---- Sheet-név A1 idézés ----
function escapeSheetName(name) {
  return String(name).replace(/'/g, "''");
}
function sheetRange(sheetName, a1Tail) {
  return `'${escapeSheetName(sheetName)}'!${a1Tail}`;
}

// ---- Formázók ----
function formatHuDate(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  const parts = new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${map.year}.${map.month}.${map.day} ${map.hour}:${map.minute}:${map.second}`;
}
const nfHu2 = new Intl.NumberFormat('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatDecimal(x) {
  const n = typeof x === 'number' ? x : Number(String(x ?? '').replace(',', '.'));
  const safe = Number.isFinite(n) ? n : 0;
  return nfHu2.format(safe);
}

// ---- Retry helper ----
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const code = e.status || e.code || 0;
      const retriable = [429, 500, 502, 503, 504].includes(code);
      if (!retriable || i === tries - 1) break;
      await new Promise(r => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw last;
}

// ---- JSON válasz küldése (Vercel/micro kompatibilis) ----
function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = {
  // request helpers
  getRawBody,
  verifyHmac,
  requireShopAndTopic,
  sendJson,

  // sheets & shopify
  getSheets,
  shopifyGQL,

  // A1 range helper
  sheetRange,

  // formatters
  formatHuDate,
  formatDecimal,

  // helpers
  withRetry,
  requireEnv,
};
