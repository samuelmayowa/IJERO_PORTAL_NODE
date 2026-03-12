// app/web/controllers/publicPaymentController.js
import * as svc from '../../services/paymentService.js';
import * as remita from '../../services/remitaService.js';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import db from '../../core/db.js';

const ONLINE_ENABLED = true;

function resolveServiceTypeId(pt){
  const nm = String(pt?.name || '').trim().toLowerCase();
  const byName =
    nm === 'school fees'       ? process.env.REMITA_STID_SCHOOL_FEES :
    nm === 'application form'  ? process.env.REMITA_STID_APPLICATION_FORM :
    nm === 'compulsory'        ? process.env.REMITA_STID_COMPULSORY :
    nm === 'acceptance'        ? process.env.REMITA_STID_ACCEPTANCE :
    nm === 'utme'              ? process.env.REMITA_STID_UTME :
    '';

  const fromRow = pt?.remita_service_type_id || pt?.service_type_id || pt?.remita_stid || pt?.stid || '';

  return String(
    process.env.REMITA_SERVICE_TYPE_ID ||
    byName ||
    fromRow ||
    process.env.REMITA_STID_DEFAULT || ''
  ).trim();
}

function getInlineConfig(){
  const mode = (process.env.REMITA_MODE || 'test').toLowerCase();

  const scriptUrl = (mode === 'live')
    ? String(process.env.REMITA_LIVE_INLINE_SCRIPT || 'https://login.remita.net/payment/v1/remita-pay-inline.bundle.js').trim()
    : String(process.env.REMITA_TEST_INLINE_SCRIPT || 'https://demo.remita.net/payment/v1/remita-pay-inline.bundle.js').trim();

  const publicKey = (mode === 'live')
    ? String(process.env.REMITA_LIVE_INLINE_PUBLIC_KEY || '').trim()
    : String(process.env.REMITA_TEST_INLINE_PUBLIC_KEY || 'QzAwMDAyNzEyNTl8MTEwNjE4NjF8OWZjOWYwNmMyZDk3MDRhYWM3YThiOThlNTNjZTE3ZjYxOTY5NDdmZWE1YzU3NDc0ZjE2ZDZjNTg1YWYxNWY3NWM4ZjMzNzZhNjNhZWZlOWQwNmJhNTFkMjIxYTRiMjYzZDkzNGQ3NTUxNDIxYWNlOGY4ZWEyODY3ZjlhNGUwYTY=').trim();

  return { mode, scriptUrl, publicKey };
}

function money(n) {
  const v = Number(n || 0);
  return `#${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function safe(v) { return (v == null || v === '') ? 'N/A' : String(v); }
function wantsJson(req){
  return (req.headers['accept'] || '').includes('application/json') || req.query.ajax === '1';
}

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
function twoColRow(doc, leftLabel, leftValue, rightLabel, rightValue, y) {
  const LxLabel = 50, LxVal = 140;
  const LlabelW = 90, LvalW = 200;
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

function renderInvoicePDF(res, p, inline=false, kind='invoice'){
  const doc = new PDFDocument({ margin: 36, size: 'A4' });
  const filename = `${p.order_id}.pdf`;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  doc.pipe(res);

  drawLogoWatermark(doc);
  if (kind === 'receipt') drawReceiptTextWatermark(doc);
  centerLogo(doc);

  doc.y = 120;

  const inst = String(p.institution_name || 'EKITI STATE COLLEGE OF HEALTH, SCIENCES & TECH.').toUpperCase();
  const addr = String(p.institution_address || 'PMB 316, IJERO EKITI, EKITI STATE OF NIGERIA');
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#111').text(inst, { align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(addr, { align: 'center' });

  const title = `${String(p.payment_type_name || 'PAYMENT').toUpperCase()} ${kind === 'receipt' ? 'PAYMENT RECEIPT' : 'INVOICE [NOT RECEIPT]'}`;
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#111').text(title, { align: 'center' });

  hr(doc, doc.y + 10);
  doc.moveDown(1);

  const printedOn = new Date().toISOString().slice(0,10);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('SECTION A', 50, doc.y);
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(`Printed On: ${printedOn}`, 120, doc.y-12);

  let y = doc.y + 12;
  y = twoColRow(doc, 'Payee Name:', safe(p.payee_fullname), 'Payee ID:', safe(p.payee_id), y);
  y = twoColRow(doc, 'Payee Email:', safe(p.payee_email), 'Payee Phone:', safe(p.payee_phone), y);
  y = twoColRow(doc, 'Payment Purpose:', safe(p.purpose || p.payment_type_purpose), '', '', y);

  hr(doc, y + 6);
  y += 16;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('SECTION B', 50, y);
  doc.font('Helvetica').fontSize(10).fillColor('#111').text('Payment Information', 120, y-12);

  y += 12;
  const total = Number(p.amount || 0) + Number(p.portal_charge || 0);
  const statusText = (safe(p.status) === 'PAID' || kind === 'receipt') ? 'PAID' : 'NOTPAID';

  y = twoColRow(doc, 'RRR NUMBER:', safe(p.rrr || 'N/A'), 'Order ID:', safe(p.order_id), y);
  y = twoColRow(doc, 'Amount Due:', money(p.amount), 'Processing Fee:', money(p.portal_charge), y);
  y = twoColRow(doc, 'Amount Payable:', money(total), 'Status:', statusText, y);
  y = twoColRow(doc, 'Payment Type:', safe(p.payment_type_name), 'Academic Session:', 'N/A', y);

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

export async function paymentForm(req, res, next){
  try {
    const types = await svc.listActivePaymentTypes();

    const from = String(req.query.from || '').trim();
    const paymentTypeId = Number(req.query.payment_type_id || 0);
    const publicUser = req.session?.publicUser || null;

    let selectedType = null;
    if (paymentTypeId > 0) {
      selectedType = await svc.getPaymentType(paymentTypeId);
    }

    let dbProfile = null;
    if (publicUser?.id) {
      const [profileRows] = await db.query(
        `
          SELECT
            pu.phone AS pu_phone,
            sp.phone AS student_phone
          FROM public_users pu
          LEFT JOIN student_profiles sp
            ON sp.user_id = pu.id
          WHERE pu.id = ?
          LIMIT 1
        `,
        [publicUser.id]
      );
      dbProfile = profileRows?.[0] || null;
    }

    const guessedEmail =
      publicUser?.email ||
      (String(publicUser?.username || '').includes('@') ? String(publicUser.username).trim() : '') ||
      '';

    const guessedPhone =
      dbProfile?.student_phone ||
      dbProfile?.pu_phone ||
      publicUser?.phone ||
      publicUser?.phone_number ||
      publicUser?.mobile ||
      req.session?.studentProfile?.phone ||
      req.session?.applicantProfile?.phone ||
      '';

    const prefill = (from === 'student-dashboard' && selectedType)
      ? {
          source: 'student-dashboard',
          payment_type_id: selectedType.id,
          amount: selectedType.amount,
          portal_charge: selectedType.portal_charge,
          purpose: selectedType.purpose || selectedType.name || '',
          payee_id: publicUser?.matric_number || publicUser?.username || guessedPhone || '',
          payee_fullname: publicUser?.full_name || '',
          payee_email: guessedEmail,
          payee_phone: guessedPhone
        }
      : null;

    const renderTypes =
      (from === 'student-dashboard' && selectedType && !types.some(t => Number(t.id) === Number(selectedType.id)))
        ? [selectedType, ...types]
        : types;

    res.render('payment/public-payment', {
      title: 'Other Payments',

      // do NOT show sidebar on payment page, even when user is logged in
      user: null,
      allowedModules: new Set(),
      currentPath: req.path || '',

      types: renderTypes,
      prefill,
      messages: req.flash ? req.flash() : {},
      csrfToken: req.csrfToken?.(),
      FAKE_RRR_ON: false,
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
    const method = String(body.method || 'BANK').toUpperCase();

    const created = await svc.createInvoice({
      payment_type_id: body.payment_type_id,
      payee_id: body.payee_id,
      payee_fullname: body.payee_fullname,
      payee_email: body.payee_email,
      payee_phone: body.payee_phone,
      purpose: body.purpose,
      amount: body.amount,
      method
    });

    const total = Number(created.amount) + Number(created.portal_charge);
    const totalAmount = Number.isFinite(total) ? total : 0;

    const rawName  = (body.payee_fullname || '').toString().trim();
    const rawEmail = (body.payee_email || '').toString().trim();
    const rawPhone = (body.payee_phone || '').toString().trim();
    const rawPurpose = (body.purpose || created.pt?.purpose || 'Payment').toString().trim();

    const payerName  = rawName || (body.payee_id ? String(body.payee_id).trim() : 'Portal Payer');
    const payerEmail = rawEmail || 'no-reply@example.com';
    const payerPhone = rawPhone || '00000000000';
    const description = rawPurpose || 'Payment';

    const serviceTypeId = resolveServiceTypeId(created.pt);
    if (!serviceTypeId) {
      throw new Error('Remita ServiceTypeId is not configured. Set REMITA_STID_* in .env or a STID column on payment_types.');
    }

    const r = await remita.createRRR({
      orderId: String(Date.now()),
      amount: totalAmount,
      payerName,
      payerEmail,
      payerPhone,
      description,
      serviceTypeId,
      customFields: [
        { name: 'Payer Name', value: payerName, type: 'ALL' },
        { name: 'Payer Email', value: payerEmail, type: 'ALL' },
        { name: 'Payer Phone', value: payerPhone, type: 'ALL' },
        { name: 'Portal OrderId', value: String(created.order_id), type: 'ALL' }
      ]
    });

    await svc.attachRRR(created.order_id, r.rrr);

    if (method === 'ONLINE') {
      const forwardUrl = `/payment/forward/${encodeURIComponent(r.rrr)}?order=${encodeURIComponent(created.order_id)}`;
      if (wantsJson(req)) return res.json({ kind: 'redirect', redirectUrl: forwardUrl, order_id: created.order_id });
      return res.redirect(forwardUrl);
    }

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

      // prevent shared layout/sidebar crash on payment pages
      user: null,
      allowedModules: new Set(),
      currentPath: req.path || '',

      messages: req.flash ? req.flash() : {},
      csrfToken: req.csrfToken?.()
    });
  } catch(e){ next(e); }
}

export async function reprintDownload(req, res, next){
  try {
    const ref = String(req.body.order_id || req.body.rrr || '').trim().replace(/[-\s]/g, '');
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
        const status = inv.rrr
          ? await remita.verifyByRRR(String(inv.rrr))
          : await remita.verifyByOrderId(String(inv.order_id));

        const code = (status?.status || status?.responseCode || status?.message || status?.statuscode || '').toString();
        const msg  = (status?.statusMessage || status?.statusmessage || status?.responseMessage || '').toString();
        const paid = /(^00$)|(^01$)/.test(code) || /success|approved/i.test(code) || /success|approved/i.test(msg);

        if (paid) {
          await svc.markPaid(inv.order_id, { remita: status });
          const [r2] = await db.query(
            `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
               FROM payment_invoices inv
               JOIN payment_types pt ON pt.id=inv.payment_type_id
              WHERE inv.order_id=? LIMIT 1`,
            [inv.order_id]
          );
          inv = r2?.[0] || inv;
        }
      } catch(e) {}
    }

    const kind = inv.status === 'PAID' ? 'receipt' : 'invoice';

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
    req.flash?.('error', e.message || 'Not found');
    res.redirect('/payment/reprint');
  }
}

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
        WHERE inv.order_id=? LIMIT 1`,
      [orderId]
    );
    const inv = rows?.[0];
    if (!inv) return res.status(404).set('Content-Type','text/plain').send('Not found');

    renderInvoicePDF(res, inv, inline, kind);
  } catch (err) {
    console.error('[print] error:', err);
    res.status(500).set('Content-Type','text/plain').send('Failed to generate PDF');
  }
}

export async function remitaCallback(req, res) {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };

    let orderId =
      params.orderId || params.orderID || params.orderid ||
      params.orderRef || params.reference || params.transRef || '';

    let rrr = String(params.rrr || params.RRR || '').trim().replace(/[-\s]/g, '');

    if (!orderId && rrr) {
      const [rows] = await db.query(
        `SELECT order_id FROM payment_invoices WHERE rrr=? LIMIT 1`,
        [rrr]
      );
      orderId = rows?.[0]?.order_id || '';
    }

    if (!orderId) return res.status(400).send('Missing orderId');

    const status = rrr
      ? await remita.verifyByRRR(rrr)
      : await remita.verifyByOrderId(String(orderId));

    const code = (status?.status || status?.responseCode || status?.message || status?.statuscode || '').toString();
    const msg  = (status?.statusMessage || status?.statusmessage || status?.responseMessage || '').toString();
    const paid = /(^00$)|(^01$)/.test(code) || /success|approved/i.test(code) || /success|approved/i.test(msg);

    if (paid) {
      await svc.markPaid(String(orderId), { remita: status, rrr: rrr || undefined });
    }

    const kind = paid ? 'receipt' : 'invoice';
    const viewUrl = `/payment/print/${encodeURIComponent(orderId)}?type=${kind}&dl=0`;
    const downloadUrl = `/payment/print/${encodeURIComponent(orderId)}?type=${kind}&dl=1`;

    const sessionUser = req.session?.publicUser || null;
    const backUrl =
      sessionUser?.role === 'student'
        ? '/student/dashboard'
        : '/';
    const backLabel =
      sessionUser?.role === 'student'
        ? 'Back to Dashboard'
        : 'Back to Home';

    return res.render('payment/result', {
      title: paid ? 'Payment Successful' : 'Payment Pending',

      // prevent shared layout/sidebar crash on payment pages
      user: null,
      allowedModules: new Set(),
      currentPath: req.path || '',

      modeTitle: paid ? 'PAYMENT SUCCESSFUL' : 'PAYMENT PENDING',
      viewUrl,
      downloadUrl,
      backUrl,
      backLabel
    });
  } catch (e) {
    console.error('[remitaCallback]', e);
    res.status(500).send('Payment verification failed.');
  }
}

export async function forwardToRemita(req, res) {
  try {
    const rrr = String(req.params.rrr || '').trim().replace(/[-\s]/g, '');
    const orderId = String(req.query.order || '').trim();
    if (!rrr) return res.status(400).send('Missing RRR.');

    const { scriptUrl, publicKey, mode } = getInlineConfig();
    if (!publicKey) {
      return res.status(500).send('Remita Inline public key is missing. Set REMITA_TEST_INLINE_PUBLIC_KEY or REMITA_LIVE_INLINE_PUBLIC_KEY in .env');
    }

    const callbackUrl = `/payment/remita/callback?orderId=${encodeURIComponent(orderId)}&rrr=${encodeURIComponent(rrr)}`;

    const html = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Opening Remita Payment…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,sans-serif;background:#f5f7fb}
    .card{max-width:560px;margin:8vh auto;padding:28px 26px;border-radius:14px;background:#fff;box-shadow:0 18px 60px rgba(0,0,0,.12)}
    .btn{display:inline-flex;align-items:center;justify-content:center;background:#2563eb;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:700;border:0;cursor:pointer}
    .muted{color:#64748b;font-size:14px;margin-top:6px}
    code{background:#f1f5f9;padding:2px 6px;border-radius:6px}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    .btn-alt{background:#e5e7eb;color:#111}
    .err{display:none;margin-top:16px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:12px;border-radius:10px}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 6px">Opening Remita Payment…</h2>
    <div class="muted">RRR: <code>${rrr}</code></div>
    <div class="muted">Mode: <code>${mode}</code></div>
    <p class="muted">If the payment window does not open automatically, click the button below.</p>

    <div class="row">
      <button id="openInlineBtn" class="btn" type="button">Continue to Payment</button>
      <a class="btn btn-alt" href="/payment/reprint">Validate / Reprint</a>
    </div>

    <div id="errBox" class="err"></div>
  </div>

  <script src="${scriptUrl}"></script>
  <script>
    (function(){
      var rrr = ${JSON.stringify(rrr)};
      var callbackUrl = ${JSON.stringify(callbackUrl)};
      var publicKey = ${JSON.stringify(publicKey)};
      var errBox = document.getElementById('errBox');
      var btn = document.getElementById('openInlineBtn');

      function showErr(msg){
        errBox.style.display = 'block';
        errBox.textContent = msg || 'Unable to open Remita payment window.';
      }

      function openInline(){
        try {
          if (typeof RmPaymentEngine === 'undefined' || !RmPaymentEngine.init) {
            showErr('Remita inline script did not load.');
            return;
          }

          var paymentEngine = RmPaymentEngine.init({
            key: publicKey,
            processRrr: true,
            transactionId: Math.floor(Math.random() * 1101233),
            extendedData: {
              customFields: [
                { name: 'rrr', value: rrr }
              ]
            },
            onSuccess: function () {
              window.location.assign(callbackUrl);
            },
            onError: function (response) {
              console.error('Remita inline error:', response);
              showErr('Payment could not be completed. You can retry or validate the RRR later.');
            },
            onClose: function () {
              console.log('Remita inline closed');
            }
          });

          paymentEngine.showPaymentWidget();
        } catch (e) {
          console.error(e);
          showErr(e && e.message ? e.message : 'Unable to open Remita payment window.');
        }
      }

      btn.addEventListener('click', openInline);
      setTimeout(openInline, 350);
    })();
  </script>
</body>
</html>`.trim();

    res.status(200).type('html').send(html);
  } catch (e) {
    console.error('[forwardToRemita]', e);
    return res.status(500).send('Failed to open Remita payment.');
  }
}