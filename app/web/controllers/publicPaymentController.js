// app/web/controllers/publicPaymentController.js
import * as svc from '../../services/paymentService.js';
import * as remita from '../../services/remitaService.js';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import db from '../../core/db.js';
import crypto from 'crypto';

// Online should be enabled now; we don't gate it behind REMITA_FAKE.
// (If you still need a dev fallback, remitaService respects REMITA_FAKE_RRR_WHEN_FAIL=1)
const ONLINE_ENABLED = true;

// ✅ NEW: for e-Collections paymentinit we must use the *platform* ServiceTypeId (4430731)
const PLATFORM_STID = process.env.REMITA_STID_DEFAULT || '4430731';

// ---------------- helpers ----------------
function money(n) {
  const v = Number(n || 0);
  return `#${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function safe(v) { return (v == null || v === '') ? 'N/A' : String(v); }
function wantsJson(req){
  return (req.headers['accept'] || '').includes('application/json') || req.query.ajax === '1';
}

// draw light repeated logo watermark
function drawLogoWatermark(doc) {
  try {
    const logoPath = path.resolve('app/web/public/img/logo.png');
    if (!fs.existsSync(logoPath)) return;
    const cols = 5, rows = 6, w = 60, h = 60, x0 = 80, y0 = 260, gx = 95, gy = 95;
    doc.save(); doc.opacity(0.06);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
      doc.image(logoPath, x0 + c*gx, y0 + r*gy, { width: w, height: h });
    doc.restore();
  } catch {}
}
function drawReceiptTextWatermark(doc){
  // Big faint red "PAYMENT RECEIPT" diagonally
  doc.save();
  doc.rotate(-30, { origin: [doc.page.width/2, doc.page.height/2] });
  doc.fillColor('#e11d48').opacity(0.08);
  doc.font('Helvetica-Bold').fontSize(72)
     .text('PAYMENT RECEIPT', (doc.page.width-600)/2, doc.page.height/2-36, { width: 600, align: 'center' });
  doc.opacity(1).fillColor('#111');
  doc.restore();
}

function centerLogo(doc) {
  try {
    const logoPath = path.resolve('app/web/public/img/logo.png');
    if (!fs.existsSync(logoPath)) return;
    doc.image(logoPath, (doc.page.width-70)/2, 38, { width: 70, height: 70 });
  } catch {}
}

function hr(doc, y = doc.y) {
  doc.strokeColor('#cfd2d4').lineWidth(1).moveTo(40, y).lineTo(doc.page.width-40, y).stroke();
}

/**
 * A4 width = 595pt. With 36pt margins, contentWidth ≈ 523pt (x: 36..559).
 */
function twoColRow(doc, leftLabel, leftValue, rightLabel, rightValue, y) {
  // Left column
  const LxLabel = 50, LxVal = 140;
  const LlabelW = 90, LvalW = 200;

  // Right column (short values only)
  const RxLabel = 360, RxVal = 450;
  const RlabelW = 90, RvalW = 90;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(leftLabel, LxLabel, y, { width: LlabelW });
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(leftValue, LxVal, y, { width: LvalW });

  if (rightLabel) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(rightLabel, RxLabel, y, { width: RlabelW });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(rightValue, RxVal, y, { width: RvalW });
  }

  const lh = Math.max(
    doc.heightOfString(String(leftValue), { width: LvalW }),
    rightLabel ? doc.heightOfString(String(rightValue), { width: RvalW }) : 0,
    14
  );
  return y + lh + 6;
}

// render invoice/receipt (matches sample layout/wording)
function renderInvoicePDF(res, p, inline=false, kind='invoice'){
  const doc = new PDFDocument({ margin: 36, size: 'A4' });
  const filename = `${p.order_id}.pdf`;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  doc.pipe(res);

  // watermark & crest
  drawLogoWatermark(doc);
  if (kind === 'receipt') drawReceiptTextWatermark(doc);
  centerLogo(doc);

  // institution name + address (centered)
  const inst = String(p.institution_name || 'EKITI STATE COLLEGE OF HEALTH, SCIENCES & TECH.').toUpperCase();
  const addr = String(p.institution_address || 'PMB 316, IJERO EKITI, EKITI STATE OF NIGERIA');
  doc.moveDown(3.6);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#111').text(inst, { align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(addr, { align: 'center' });

  // main title
  const title = `${String(p.payment_type_name || 'PAYMENT').toUpperCase()} ${kind === 'receipt' ? 'PAYMENT RECEIPT' : 'INVOICE [NOT RECEIPT]'}`;
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#111').text(title, { align: 'center' });

  hr(doc, doc.y + 10);
  doc.moveDown(1);

  // ===== SECTION A (with "Printed On:" inline) =====
  const printedOn = new Date().toISOString().slice(0,10);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('SECTION A', 50, doc.y);
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(`Printed On: ${printedOn}`, 120, doc.y-12);

  let y = doc.y + 12;
  y = twoColRow(doc, 'Payee Name:', safe(p.payee_fullname), 'Payee ID:', safe(p.payee_id), y);
  y = twoColRow(doc, 'Payee Email:', safe(p.payee_email), 'Payee Phone:', safe(p.payee_phone), y);
  y = twoColRow(doc, 'Payment Purpose:', safe(p.purpose || p.payment_type_purpose), '', '', y);

  hr(doc, y + 6);
  y += 16;

  // ===== SECTION B =====
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('SECTION B', 50, y);
  doc.font('Helvetica').fontSize(10).fillColor('#111').text('Payment Information', 120, y-12);

  y += 12;
  const total = Number(p.amount || 0) + Number(p.portal_charge || 0);
  const statusText = (safe(p.status) === 'PAID' || kind === 'receipt') ? 'PAID' : 'NOTPAID';

  y = twoColRow(doc, 'RRR NUMBER:', safe(p.rrr || 'N/A'), 'Order ID:', safe(p.order_id), y);
  y = twoColRow(doc, 'Amount Due:', money(p.amount), 'Processing Fee:', money(p.portal_charge), y);
  y = twoColRow(doc, 'Amount Payable:', money(total), 'Status:', statusText, y);
  y = twoColRow(doc, 'Payment Type:', safe(p.payment_type_name), 'Academic Session:', 'N/A', y);

  // ===== SECTION C (full-width narrative + banks), left-aligned =====
  hr(doc, y + 10);
  y = y + 18;

  const leftX = 50;
  const fullW = doc.page.width - 2*36 - (leftX - 36);
  const methodText = (String(p.method).toUpperCase() === 'ONLINE' || kind === 'receipt')
    ? 'Payment Method: Pay on REMITA (Online).'
    : `Payment Method: Pay your ${safe(p.payment_type_name)} ON REMITA PLATFORM in any of the bank listed below nationwide.`;

  doc.font('Helvetica').fontSize(10).fillColor('#111')
     .text(methodText, leftX, y, { width: fullW, lineGap: 1.4 });
  y = doc.y + 10;

  hr(doc, y);
  y += 6;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111')
     .text('List of eligible Banks', 36, y, { align: 'center' });
  y = doc.y + 6;

  const colStart = 50;
  const colW = Math.floor((doc.page.width - 2*colStart) / 4);
  const rows = [
    ['First Bank', 'WEMA Bank', 'UBA', 'Access Bank'],
    ['Diamond Bank Plc', 'GTBank', 'Keystone Bank', 'First City Monument Bank'],
    ['Heritage Enterprise Bank', 'Sterling Bank', 'Mainstreet Bank', 'Zenith Bank'],
    ['Ecobank', 'Fidelity Bank', 'Union Bank', 'Stanbic IBTC'],
    ['Polaris Bank', 'Citi Bank', 'Unity Bank', 'Standard Chartered Bank']
  ];

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111');
  for (const r of rows) {
    let x = colStart;
    let rowH = 0;
    for (let i = 0; i < 4; i++) {
      const text = r[i] || '';
      const h = doc.heightOfString(text, { width: colW });
      rowH = Math.max(rowH, h);
      doc.text(text, x, y, { width: colW });
      x += colW;
    }
    y += rowH + 6;
  }

  y += 4;
  doc.font('Helvetica').fontSize(9).fillColor('#444')
     .text('Please Note: Any payment made on any platform apart from REMITA platform stands the risk of loosing the fund.',
           36, y, { align: 'center' });

  const year = new Date().getFullYear();
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(`Copyright EKCOHTECH ${year}`, 50, doc.page.height - 50, { align: 'left' });

  doc.end();
}

// ---------------- pages & APIs ----------------
export async function paymentForm(req, res, next){
  try {
    const types = await svc.listActivePaymentTypes();
    res.render('payment/public-payment', {
      title: 'Other Payments',
      types,
      messages: req.flash ? req.flash() : {},
      csrfToken: req.csrfToken?.(),
      FAKE_RRR_ON: false,            // enable "Online (Remita)" option
      ONLINE_ENABLED
    });
  } catch(e){ next(e); }
}

export async function fetchType(req, res, next){
  try {
    const id = Number(req.params.id);
    const row = await svc.getPaymentType(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ id: row.id, amount: row.amount, portal_charge: row.portal_charge, name: row.name, purpose: row.purpose });
  } catch(e){ next(e); }
}

export async function createInvoice(req, res, next){
  try {
    const body = req.body || {};
    const method = String(body.method || 'BANK').toUpperCase(); // BANK or ONLINE

    // 1) create local invoice row
    const created = await svc.createInvoice({
      payment_type_id: body.payment_type_id,
      payee_id: body.payee_id,
      payee_fullname: body.payee_fullname,
      payee_email: body.payee_email,
      payee_phone: body.payee_phone,
      purpose: body.purpose,
      method
    });

    // --- Normalize values for Remita (avoid nulls) ---
    const total = Number(created.amount) + Number(created.portal_charge);
    const amount2dp = Number(total || 0).toFixed(2);

    const rawName  = (body.payee_fullname || '').toString().trim();
    const rawEmail = (body.payee_email || '').toString().trim();
    const rawPhone = (body.payee_phone || '').toString().trim();
    const rawPurpose = (body.purpose || created.pt?.purpose || 'Payment').toString().trim();

    const payerName  = rawName || (body.payee_id ? String(body.payee_id).trim() : 'Portal Payer');
    const payerEmail = rawEmail || 'no-reply@example.com';
    const payerPhone = rawPhone || '00000000000';
    const description = rawPurpose || 'Payment';

    // ✅ CHANGED: use the platform STID (4430731) for paymentinit
    const serviceTypeId = PLATFORM_STID;

    // 2) get RRR from Remita
    const r = await remita.createRRR({
      orderId: created.order_id,
      amount: amount2dp,
      payerName,
      payerEmail,
      payerPhone,
      description,
      serviceTypeId
    });
    await svc.attachRRR(created.order_id, r.rrr);

    // Remita's pay page (finalize.reg) requires a POST; so we bounce the user
    // through our own page that auto-POSTs to Remita with { rrr, responseurl }.
    if (method === 'ONLINE') {
      const forwardUrl = `/payment/forward/${encodeURIComponent(r.rrr)}?order=${encodeURIComponent(created.order_id)}`;
      if (wantsJson(req)) return res.json({ kind: 'redirect', redirectUrl: forwardUrl, order_id: created.order_id });
      return res.redirect(forwardUrl);
    }


    // BANK: show invoice now
    if (wantsJson(req)) {
      return res.json({
        ok: true,
        order_id: created.order_id,
        rrr: r.rrr,
        view_url: `/payment/print/${encodeURIComponent(created.order_id)}?type=invoice&dl=0`,
        download_url: `/payment/print/${encodeURIComponent(created.order_id)}?type=invoice&dl=1`,
        kind: 'invoice'
      });
    }
    res.redirect(`/payment/print/${encodeURIComponent(created.order_id)}?type=invoice&dl=0`);
  } catch(e){
    if (wantsJson(req)) return res.status(400).json({ ok:false, error: e.message || 'Failed' });
    next(e);
  }
}

export async function reprintForm(req, res, next){
  try {
    res.render('payment/reprint', {
      title: 'Reprint Invoice / Validate RRR',
      messages: req.flash ? req.flash() : {},
      csrfToken: req.csrfToken?.()
    });
  } catch(e){ next(e); }
}

// Reprint + Validate:
// - If local status is PENDING, ask Remita by orderId.
// - If Remita says PAID, set local status to PAID and print RECEIPT.
// - Else print INVOICE.
export async function reprintDownload(req, res, next){
  try {
    const ref = String(req.body.order_id || req.body.rrr || '').trim();
    if (!ref) throw new Error('Enter your Order ID or RRR');

    const [rows] = await db.query(
      `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
         FROM payment_invoices inv
         JOIN payment_types pt ON pt.id=inv.payment_type_id
        WHERE inv.order_id=? OR inv.rrr=? LIMIT 1`,
      [ref, ref]
    );
    let inv = rows?.[0];
    if (!inv) throw new Error('Invoice/Receipt not found');

    if (inv.status !== 'PAID') {
      try {
        const status = await remita.verifyByOrderId(inv.order_id);
        // Remita success codes commonly include '00' or status "Successful".
        const code = (status?.responseCode || status?.status || status?.message || '').toString();
        const paid = /(^00$)|success/i.test(code) || /Successful/i.test(status?.responseMessage || '');
        if (paid) {
          await svc.markPaid(inv.order_id, { remita: status });
          inv = await svc.refreshInvoice(inv.order_id);
        }
      } catch(e) {
        // ignore verification failure; fall back to invoice
      }
    }

    const isReceipt = inv.status === 'PAID';
    const kind = isReceipt ? 'receipt' : 'invoice';

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        order_id: inv.order_id,
        kind,
        viewUrl: `/payment/print/${encodeURIComponent(inv.order_id)}?type=${kind}&dl=0`,
        downloadUrl: `/payment/print/${encodeURIComponent(inv.order_id)}?type=${kind}&dl=1`
      });
    }
    return renderInvoicePDF(res, inv, false, kind);
  } catch(e){
    if (wantsJson(req)) return res.status(400).json({ ok:false, error: e.message || 'Failed' });
    req.flash?.('error', e.message || 'Not found'); res.redirect('/payment/reprint');
  }
}

// Stream View/Download
export async function print(req, res, next){
  const orderId = String(req.params.orderId || '').trim();
  const kind = (String(req.query.type || 'invoice').toLowerCase() === 'receipt') ? 'receipt' : 'invoice';
  const inline = !(String(req.query.dl || '') === '1' || String(req.query.dl || '') === 'true');

  if (!orderId) return res.status(400).set('Content-Type','text/plain').send('Missing orderId');

  try {
    const [rows] = await db.query(
      `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
         FROM payment_invoices inv
         JOIN payment_types pt ON pt.id=inv.payment_type_id
        WHERE inv.order_id=? LIMIT 1`, [orderId]
    );
    const inv = rows?.[0];
    if (!inv) return res.status(404).set('Content-Type','text/plain').send('Not found');

    renderInvoicePDF(res, inv, inline, kind);
  } catch (err) {
    console.error('[print] error:', err);
    res.status(500).set('Content-Type','text/plain').send('Failed to generate PDF');
  }
}

// Remita returns here after Online payment.
// We verify by orderId (or, if missing, by RRR→orderId lookup), mark PAID, then show Receipt.
export async function remitaCallback(req, res) {
  try {
    // Try all the common orderId keys first…
    let orderId =
      req.query.orderId || req.query.orderID || req.query.orderid ||
      req.query.orderRef || req.query.reference || req.query.transRef || '';

    // If not present, but we got an RRR, map RRR → local orderId
    if (!orderId) {
      const rrr = String(req.query.rrr || req.query.RRR || '').trim();
      if (rrr) {
        const [rows] = await db.query(
          `SELECT order_id FROM payment_invoices WHERE rrr=? LIMIT 1`,
          [rrr]
        );
        orderId = rows?.[0]?.order_id || '';
      }
    }

    if (!orderId) return res.status(400).send('Missing orderId');

    // Verify with Remita by orderId
    const status = await remita.verifyByOrderId(String(orderId));
    const code   = (status?.responseCode || status?.status || status?.message || '').toString();
    const paid = (
      /(^00$)|(^01$)/.test(code) ||                    // exact code 00 or 01
      /success/i.test(code) ||                        
      /Successful/i.test(status?.responseMessage || '')
    );


    if (paid) {
      await svc.markPaid(String(orderId), { remita: status });
    }

    const kind        = paid ? 'receipt' : 'invoice';
const viewUrl     = `/payment/print/${encodeURIComponent(orderId)}?type=${kind}&dl=0`;
const downloadUrl = `/payment/print/${encodeURIComponent(orderId)}?type=${kind}&dl=1`;
return res.render('payment/result', {
  modeTitle: paid ? 'PAYMENT SUCCESSFUL' : 'PAYMENT PENDING',
  viewUrl, downloadUrl
});
  } catch (e) {
    console.error('[remitaCallback]', e);
    res.status(500).send('Payment verification failed.');
  }
}

// Auto-POST the user to Remita's pay page (finalize.reg) with the required fields.
export async function forwardToRemita(req, res) {
  try {
    const rrr     = String(req.params.rrr || '').trim();
    const orderId = String(req.query.order || '').trim();
    if (!rrr) return res.status(400).send('Missing RRR.');

    const mode = (process.env.REMITA_MODE || 'test').toLowerCase();
    const payPage = (mode === 'live'
      ? (process.env.REMITA_LIVE_PAYPAGE || '')
      : (process.env.REMITA_TEST_PAYPAGE || '')
    ).replace(/\/+$/,''); // trim trailing slash

    const baseReturn = (process.env.REMITA_RETURN_URL || '').trim();
    // Ensure our callback gets both orderId and rrr even if Remita doesn’t send them back
    const returnUrl = baseReturn
      ? `${baseReturn}${baseReturn.includes('?') ? '&' : '?'}orderId=${encodeURIComponent(orderId)}&rrr=${encodeURIComponent(rrr)}`
      : '';

    const html = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Redirecting to Remita…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,sans-serif;background:#f5f7fb}
    .card{max-width:520px;margin:8vh auto;padding:28px 26px;border-radius:14px;background:#fff;box-shadow:0 18px 60px rgba(0,0,0,.12)}
    .btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700}
    .muted{color:#64748b;font-size:14px;margin-top:6px}
    code{background:#f1f5f9;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 6px">Redirecting to Remita…</h2>
    <div class="muted">RRR: <code>${rrr}</code></div>
    <p class="muted">If nothing happens in a second, click the button below.</p>

    <form id="to-remita" method="POST" action="${payPage}">
      <input type="hidden" name="rrr" value="${rrr}">
      ${ returnUrl ? `<input type="hidden" name="responseurl" value="${returnUrl}">` : '' }
      <button class="btn" type="submit">Continue</button>
    </form>
  </div>
  <script>(function(){try{document.getElementById('to-remita').submit();}catch(_){}})();</script>
</body>
</html>`.trim();

    res.status(200).type('html').send(html);
  } catch (err) {
    console.error('forwardToRemita error:', err);
    res.status(500).send('Unable to forward to Remita at the moment.');
  }
}


