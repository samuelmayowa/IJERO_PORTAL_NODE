// app/services/remitaService.js  (ESM)
// Remita e-Collections helpers (paymentinit + status)
// Token per doc: SHA512(merchantId + serviceTypeId + orderId + totalAmount + apiKey)

import crypto from 'crypto';
import fetch from 'node-fetch';

const MODE = (process.env.REMITA_MODE || 'test').toLowerCase();
const CONF = (MODE === 'live')
  ? {
      merchantId: process.env.REMITA_LIVE_MERCHANT_ID,
      apiKey:     process.env.REMITA_LIVE_API_KEY,
      base:       (process.env.REMITA_LIVE_BASE_URL || '').replace(/\/+$/,''),
      paypage:    process.env.REMITA_LIVE_PAYPAGE
    }
  : {
      merchantId: process.env.REMITA_TEST_MERCHANT_ID,
      apiKey:     process.env.REMITA_TEST_API_KEY,
      base:       (process.env.REMITA_TEST_BASE_URL || '').replace(/\/+$/,''),
      paypage:    process.env.REMITA_TEST_PAYPAGE
    };

const RETURN_URL = process.env.REMITA_RETURN_URL || '';
const DEBUG_REMITA = process.env.DEBUG_REMITA === '1';

// ---------- utils ----------
const sha512 = s => crypto.createHash('sha512').update(String(s), 'utf8').digest('hex');
const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json; charset=UTF-8', ...extra });

/** POST JSON and, if 30x, re-POST to Location with same body */
async function postJsonKeepingPost(url, body, headers = {}) {
  const bodyStr = JSON.stringify(body);
  let res = await fetch(url, { method: 'POST', headers: jsonHeaders(headers), body: bodyStr, redirect: 'manual' });

  // follow up to two redirects, keeping POST+body
  let hops = 0;
  while ([301,302,307,308].includes(res.status) && hops < 2) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
    res = await fetch(next, { method: 'POST', headers: jsonHeaders(headers), body: bodyStr, redirect: 'manual' });
    hops++;
  }
  return res;
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
}

function pickRRR(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') {
    const m = payload.match(/"RRR"\s*:\s*"(\d+)"/) || payload.match(/\bRRR["']?\s*[:=]\s*["']?(\d{6,})/i);
    return m ? m[1] : null;
  }
  return payload.RRR || payload.rrr || payload?.responseParams?.RRR || null;
}

// ---------- public helpers your controller already uses ----------
export function payPage(rrr) {
  const base = CONF.paypage;
  const qs = new URLSearchParams({ rrr });
  if (RETURN_URL) qs.set('responseurl', RETURN_URL);
  return `${base}?${qs.toString()}`;
}

/**
 * createRRR → POST /merchant/api/paymentinit (doc-compliant)
 * body.amount = string; token uses same amount as totalAmount in the hash
 */
export async function createRRR({
  orderId,
  amount,            // number or string in naira; we'll stringify
  serviceTypeId,     // use platform STID for paymentinit (e.g. "4430731")
  payerName,
  payerEmail,
  payerPhone,
  description,
  customFields       // optional: [{name,value,type}]
}) {
  if (!CONF.merchantId || !CONF.apiKey || !CONF.base) {
    throw new Error('Remita not configured. Check .env values.');
  }

  // amount string (Remita samples show integer strings; 2dp also accepted on many tenants)
  let amtStr;
  if (typeof amount === 'number') {
    amtStr = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  } else {
    amtStr = String(amount ?? '').replace(/,/g,'').trim();
    if (!amtStr) amtStr = '0';
  }

  // Some tenants prefer numeric orderId; if not numeric, still send what you have (portal ID)
  const ord = String(orderId);

  // Token must be built with totalAmount (use same string we send as amount)
  const token = sha512(String(CONF.merchantId) + String(serviceTypeId) + ord + amtStr + String(CONF.apiKey));
  const authHeader = `remitaConsumerKey=${CONF.merchantId},remitaConsumerToken=${token}`;

  const body = {
    serviceTypeId: String(serviceTypeId),
    amount:        amtStr,             // body key is "amount"
    orderId:       ord,
    payerName:     String(payerName || '').trim(),
    payerEmail:    String(payerEmail || '').trim(),
    payerPhone:    String(payerPhone || '').trim(),
    description:   String(description || '').trim()
  };

  if (Array.isArray(customFields) && customFields.length) {
    body.customFields = customFields.map(cf => ({
      name:  String(cf.name || '').trim(),
      value: String(cf.value || '').trim(),
      type:  String(cf.type || 'ALL').trim() || 'ALL'
    })).filter(cf => cf.name && cf.value);
  }

  if (!body.payerName)  throw new Error('payerName is required');
  if (!body.payerEmail) throw new Error('payerEmail is required');
  if (!body.payerPhone) throw new Error('payerPhone is required');
  if (!body.description) body.description = 'Payment';

  const urls = [
    `${CONF.base}/merchant/api/paymentinit`,
    `${CONF.base}/merchant/api/paymentinit/`
  ];

  let last = { status: 0, text: '' };

  for (const u of urls) {
    const res = await postJsonKeepingPost(u, body, { Authorization: authHeader, Accept: 'application/json' });
    const txt = await res.text();
    last = { status: res.status, text: txt };

    // demo sometimes replies jsonp: ({"statuscode":"025","RRR":"..."})
    const clean = txt.trim().startsWith('(') ? txt.trim().slice(1, -1) : txt;
    let data; try { data = JSON.parse(clean); } catch { data = txt; }

    // Success sample: {"statuscode":"025","RRR":"130007846382","status":"Payment Reference generated"}
    const rrr = pickRRR(data);
    if (rrr) {
      if (DEBUG_REMITA) console.log('[Remita:init] OK %s RRR=%s', u, rrr);
      return { rrr, raw: data };
    }

    // Some tenants send 200 + {"status":"INVALID_REQUEST"} on config errors
    // Try next URL variant if present
  }

  throw new Error(`Remita init failed (HTTP ${last.status}): ${last.text || 'Invalid Request'}`);
}

/**
 * verifyByOrderId → GET …/echannelsvc/{merchantId}/{orderId}/{hash}/orderstatus.reg
 * hash = SHA512(orderId + apiKey + merchantId)
 */
export async function verifyByOrderId(orderId) {
  if (!CONF.merchantId || !CONF.apiKey || !CONF.base) {
    throw new Error('Remita not configured.');
  }
  const ord = String(orderId);
  const hash = sha512(ord + String(CONF.apiKey) + String(CONF.merchantId));
  const url  = `${CONF.base}/${CONF.merchantId}/${encodeURIComponent(ord)}/${hash}/orderstatus.reg`;

  const res = await getJson(url, {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `remitaConsumerKey=${CONF.merchantId},remitaConsumerToken=${hash}`
  });

  // Typical success body includes status "00" or message "Successful"
  return res.data;
}
