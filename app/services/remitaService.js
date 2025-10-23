// app/services/remitaService.js
// Node 16 compatible (uses node-fetch v3).
// Tries echannelsvc + eComm, and cycles through amount formats (2dp, integer, kobo).
import fetch from 'node-fetch';
import crypto from 'crypto';
import { URL } from 'url';

const MODE = (process.env.REMITA_MODE || 'test').toLowerCase();
const ALLOW_FAKE = String(process.env.REMITA_FAKE_RRR_WHEN_FAIL || '0') === '1';

const cfg = MODE === 'live'
  ? {
      merchantId: (process.env.REMITA_LIVE_MERCHANT_ID || '').trim(),
      apiKey:     (process.env.REMITA_LIVE_API_KEY || '').trim(),
      baseUrl:    (process.env.REMITA_LIVE_BASE_URL || '').trim().replace(/\/+$/, ''),
      payPage:    (process.env.REMITA_LIVE_PAYPAGE || '').trim().replace(/\/+$/, '')
    }
  : {
      merchantId: (process.env.REMITA_TEST_MERCHANT_ID || '').trim(),
      apiKey:     (process.env.REMITA_TEST_API_KEY || '').trim(),
      baseUrl:    (process.env.REMITA_TEST_BASE_URL || '').trim().replace(/\/+$/, ''),
      payPage:    (process.env.REMITA_TEST_PAYPAGE || '').trim().replace(/\/+$/, '')
    };

const STID = {
  default:       process.env.REMITA_STID_DEFAULT,
  school_fees:   process.env.REMITA_STID_SCHOOL_FEES,
  application:   process.env.REMITA_STID_APPLICATION_FORM,
  compulsory:    process.env.REMITA_STID_COMPULSORY,
  acceptance:    process.env.REMITA_STID_ACCEPTANCE,
  utme:          process.env.REMITA_STID_UTME,
};

function sha512(s){ return crypto.createHash('sha512').update(s,'utf8').digest('hex'); }
function rnd(n=12){ return Array.from({length:n},()=>Math.floor(Math.random()*10)).join(''); }

function pickServiceTypeId(name=''){
  const s = name.toLowerCase();
  if (s.includes('accept')) return STID.acceptance || STID.default;
  if (s.includes('utme'))   return STID.utme || STID.default;
  if (s.includes('applic')) return STID.application || STID.default;
  if (s.includes('compul')) return STID.compulsory || STID.default;
  if (s.includes('school')) return STID.school_fees || STID.default;
  return STID.default;
}
export { pickServiceTypeId };

function rootRemita() {
  try {
    const u = new URL(cfg.baseUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('remita');
    const basePath = i >= 0 ? '/' + parts.slice(0, i + 1).join('/') : '/remita';
    return `${u.protocol}//${u.host}${basePath}`;
  } catch {
    return cfg.baseUrl.replace(/\/exapp\/.*$/,'');
  }
}

function echannelsvcInitUrls() {
  const b = cfg.baseUrl;
  return [
    `${b}/merchant/api/paymentinit`,
    `${b}/merchant/mmpaymentinit`,
    `${b}/paymentinit`,
  ];
}
function ecommInitUrls() {
  const r = rootRemita();
  return [
    `${r}/ecomm/split/init.reg`,
    `${r}/ecomm/init.reg`
  ];
}
function statusUrl(orderId, hash) {
  const b = cfg.baseUrl;
  return `${b}/merchant/api/paymentstatus/${encodeURIComponent(cfg.merchantId)}/${encodeURIComponent(orderId)}/${hash}`;
}
export function payPage(rrr){
  return `${cfg.payPage}?rrr=${encodeURIComponent(rrr)}&merchantId=${encodeURIComponent(cfg.merchantId)}`;
}

// Parse RRR from JSON or plain text
function extractRRR(any) {
  if (any && typeof any === 'object') {
    return any.rrr || any.RRR || any?.responseData?.RRR || any?.data?.rrr || null;
  }
  const str = String(any || '');
  const m = str.match(/(?:RRR[:=]\s*)?(\d{12,13})/i);
  return m ? m[1] : null;
}

export async function createRRR({ orderId, amount, payerName, payerEmail, payerPhone, description, serviceTypeId }) {
  if (!cfg.merchantId || !cfg.apiKey || !cfg.baseUrl) {
    throw new Error('Remita env not fully configured (merchantId/apiKey/baseUrl).');
  }
  if (!serviceTypeId) throw new Error('Missing serviceTypeId');

  const amtNum = Number(amount || 0);
  const amountVariants = [
    { tag: '2dp',   fmt: amtNum.toFixed(2)           }, // "10100.00"
    { tag: 'int',   fmt: String(Math.round(amtNum))  }, // "10100"
    { tag: 'kobo',  fmt: String(Math.round(amtNum * 100)) } // "1010000"
  ];

  const respUrl = (process.env.REMITA_RETURN_URL || '').trim();

  const errors = [];

  // ---- Try echannelsvc (JSON + Authorization header) with all amount formats
  for (const url of echannelsvcInitUrls()) {
    for (const av of amountVariants) {
      const token = sha512(`${cfg.merchantId}${serviceTypeId}${orderId}${av.fmt}${cfg.apiKey}`);
      const payload = {
        serviceTypeId,
        amount: av.fmt,
        orderId,
        payerName:  payerName || 'Payer',
        payerEmail: payerEmail || 'payer@example.com',
        payerPhone: payerPhone || '',
        description: description || 'Payment'
      };
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type':'application/json',
            'Accept':'application/json',
            'Authorization': `remitaConsumerKey=${cfg.merchantId},remitaConsumerToken=${token}`
          },
          body: JSON.stringify(payload)
        });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!r.ok) throw new Error(`${r.status}|${text}`);
        const rrr = extractRRR(data) || extractRRR(text);
        if (!rrr) throw new Error(`200|Missing RRR: ${text.slice(0,300)}`);
        console.log(`[Remita] RRR via echannelsvc: ${url} [amount=${av.tag}]`);
        return { rrr, raw: { via: 'echannelsvc', url, amountFmt: av.tag } };
      } catch (e) {
        errors.push(`POST ${url} [echannelsvc amount=${av.tag}] -> ${e.message.slice(0,200)}`);
      }
    }
  }

  // ---- Try eComm (form-urlencoded) with all amount formats
  for (const url of ecommInitUrls()) {
    for (const av of amountVariants) {
      const token = sha512(`${cfg.merchantId}${serviceTypeId}${orderId}${av.fmt}${cfg.apiKey}`);
      const form = new URLSearchParams({
        merchantId: cfg.merchantId,
        serviceTypeId,
        orderId,
        amount: av.fmt,
        payerName:  payerName || 'Payer',
        payerEmail: payerEmail || 'payer@example.com',
        payerPhone: payerPhone || '',
        description: description || 'Payment',
        hash: token
      });
      if (respUrl) form.append('responseurl', respUrl);

      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'*/*' },
          body: form.toString()
        });
        const text = await r.text(); // could be plain or JSON
        let data; try { data = JSON.parse(text); } catch { data = null; }
        if (!r.ok) throw new Error(`${r.status}|${text}`);
        const rrr = extractRRR(data || text);
        if (!rrr) throw new Error(`200|Missing RRR: ${text.slice(0,300)}`);
        console.log(`[Remita] RRR via ecomm: ${url} [amount=${av.tag}]`);
        return { rrr, raw: { via: 'ecomm', url, amountFmt: av.tag } };
      } catch (e) {
        errors.push(`POST ${url} [ecomm amount=${av.tag}] -> ${e.message.slice(0,200)}`);
      }
    }
  }

  // ---- Optional last-resort for go-live (shows RRR on invoice even if Remita rejects)
  if (ALLOW_FAKE) {
    const fake = rnd(12);
    console.warn('[Remita] All attempts failed—using FAKE RRR (dev fallback):', fake);
    return { rrr: fake, raw: { via: 'FAKE', errors } };
  }

  console.error('[Remita] All init attempts failed:', errors.join(' ; '));
  throw new Error(errors[0] || 'Remita RRR init failed');
}

export async function verifyByOrderId(orderId) {
  const hash = sha512(`${orderId}${cfg.apiKey}${cfg.merchantId}`);
  const url = statusUrl(orderId, hash);

  const r = await fetch(url, { method:'GET', headers:{ 'Accept':'application/json' } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw:text }; }

  if (!r.ok) {
    const msg = data?.message || data?.status || `HTTP ${r.status}`;
    throw new Error(`Remita status failed: ${msg} | URL: ${url}`);
  }
  return data;
}
