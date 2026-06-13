// app/web/controllers/generalPaymentController.js
import * as svc from '../../services/paymentService.js';
import db from '../../core/db.js';

function cleanText(v) {
  return String(v || '').trim();
}

function key(v) {
  return cleanText(v).toLowerCase();
}

function fullNameFromUser(u = {}) {
  const user = u || {};
  return [user.first_name, user.middle_name, user.last_name]
    .map(cleanText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkArray(arr, size = 400) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchPublicUsersForPayments(rows = []) {
  const candidates = new Set();

  for (const r of rows) {
    for (const v of [r.payee_id, r.payee_email, r.payee_phone]) {
      const c = cleanText(v);
      if (c) candidates.add(c);
    }
  }

  const all = [...candidates];
  const maps = {
    byMatric: new Map(),
    byEmail: new Map(),
    byPhone: new Map(),
    byId: new Map(),
  };

  if (!all.length) return maps;

  for (const part of chunkArray(all)) {
    const [found] = await db.query(
      `
      SELECT
        id,
        first_name,
        middle_name,
        last_name,
        username,
        phone,
        matric_number
      FROM public_users
      WHERE role = 'student'
        AND (
          matric_number IN (?)
          OR username IN (?)
          OR phone IN (?)
          OR CAST(id AS CHAR) IN (?)
        )
      `,
      [part, part, part, part]
    );

    for (const u of found || []) {
      if (cleanText(u.matric_number)) maps.byMatric.set(key(u.matric_number), u);
      if (cleanText(u.username)) maps.byEmail.set(key(u.username), u);
      if (cleanText(u.phone)) maps.byPhone.set(key(u.phone), u);
      maps.byId.set(String(u.id), u);
    }
  }

  return maps;
}

async function fetchStudentImportDepartments(rows = [], userMaps) {
  const matrics = new Set();
  const emails = new Set();

  for (const r of rows) {
    const payeeId = cleanText(r.payee_id);
    const email = cleanText(r.payee_email);

    if (payeeId) matrics.add(payeeId);
    if (email) emails.add(email);

    const u =
      userMaps.byMatric.get(key(payeeId)) ||
      userMaps.byEmail.get(key(payeeId)) ||
      userMaps.byEmail.get(key(email)) ||
      userMaps.byPhone.get(key(r.payee_phone)) ||
      userMaps.byId.get(payeeId);

    if (u?.matric_number) matrics.add(cleanText(u.matric_number));
    if (u?.username) emails.add(cleanText(u.username));
  }

  const maps = {
    byMatric: new Map(),
    byEmail: new Map(),
  };

  for (const part of chunkArray([...matrics].filter(Boolean))) {
    const [found] = await db.query(
      `
      SELECT matric_number, student_email, department
      FROM student_imports
      WHERE matric_number IN (?)
      `,
      [part]
    );

    for (const row of found || []) {
      if (cleanText(row.matric_number) && cleanText(row.department)) {
        maps.byMatric.set(key(row.matric_number), cleanText(row.department));
      }
      if (cleanText(row.student_email) && cleanText(row.department)) {
        maps.byEmail.set(key(row.student_email), cleanText(row.department));
      }
    }
  }

  for (const part of chunkArray([...emails].filter(Boolean))) {
    const [found] = await db.query(
      `
      SELECT matric_number, student_email, department
      FROM student_imports
      WHERE student_email IN (?)
      `,
      [part]
    );

    for (const row of found || []) {
      if (cleanText(row.matric_number) && cleanText(row.department)) {
        maps.byMatric.set(key(row.matric_number), cleanText(row.department));
      }
      if (cleanText(row.student_email) && cleanText(row.department)) {
        maps.byEmail.set(key(row.student_email), cleanText(row.department));
      }
    }
  }

  return maps;
}

async function enrichPaymentExportRows(rows = []) {
  const userMaps = await fetchPublicUsersForPayments(rows);
  const deptMaps = await fetchStudentImportDepartments(rows, userMaps);

  return rows.map((r) => {
    const payeeId = cleanText(r.payee_id);
    const email = cleanText(r.payee_email);
    const phone = cleanText(r.payee_phone);

    const u =
      userMaps.byMatric.get(key(payeeId)) ||
      userMaps.byEmail.get(key(payeeId)) ||
      userMaps.byEmail.get(key(email)) ||
      userMaps.byPhone.get(key(phone)) ||
      userMaps.byId.get(payeeId) ||
      null;

    const matric = cleanText(u?.matric_number) || payeeId;
    const resolvedEmail = cleanText(u?.username) || email;

    const resolvedName = fullNameFromUser(u) || cleanText(r.payee_fullname);
    const firstName = cleanText(u?.first_name);
    const middleName = cleanText(u?.middle_name);
    const lastName = cleanText(u?.last_name);

    const department =
      deptMaps.byMatric.get(key(matric)) ||
      deptMaps.byEmail.get(key(resolvedEmail)) ||
      '';

    return {
      ...r,
      export_payee_fullname: resolvedName,
      export_first_name: firstName,
      export_middle_name: middleName,
      export_last_name: lastName,
      export_department: department,
    };
  });
}

// Admin – All / General Payment (report)
export async function index(req, res, next){
  try {
    const page   = Number(req.query.page || 1);
    const q      = String(req.query.q || '').trim();
    const from   = req.query.from || '';
    const to     = req.query.to || '';
    const status = (req.query.status || 'ALL').toUpperCase();   // ALL | PENDING | PAID
    const method = (req.query.method || 'ALL').toUpperCase();   // ALL | ONLINE | BANK
    const typeId = req.query.typeId || '';

    const data = await svc.listInvoices({
      page, pageSize: 20, q, from, to, status, method, typeId
    });

    const types = await svc.listActivePaymentTypes(); // for dropdown

    res.render('payment/admin-payments-list', {
      title: 'All / General Payment',
      q, from, to, status, method, typeId,
      types,
      ...data,
      messages: req.flash?.() || {},
    });
  } catch (e) {
    next(e);
  }
}

// CSV export (updated to include RRR + Name and relabel Payee ID / Matric)
export async function exportCsv(req, res, next){
  try {
    const q      = String(req.query.q || '').trim();
    const from   = req.query.from || '';
    const to     = req.query.to || '';
    const status = (req.query.status || 'ALL').toUpperCase();
    const method = (req.query.method || 'ALL').toUpperCase();
    const typeId = req.query.typeId || '';

    const data = await svc.listInvoices({
      page: 1,
      pageSize: 100000,
      exportAll: true,
      q,
      from,
      to,
      status,
      method,
      typeId,
    });

    const rows = await enrichPaymentExportRows(data.rows || []);
    const header = [
      'Order ID','RRR','Payment Type','Amount','Portal Charge','Method','Status',
      'Full Name','First Name','Middle Name','Last Name','Payee ID / Matric','Department','Email','Phone','Created At'
    ];

    const csv = [
      header.join(','),
      ...rows.map(r => [
        r.order_id, r.rrr || '',
        r.payment_type_name,
        r.amount, r.portal_charge, r.method, r.status,
        r.export_payee_fullname || r.payee_fullname || '',
        r.export_first_name || '',
        r.export_middle_name || '',
        r.export_last_name || '',
        r.payee_id || '',
        r.export_department || '',
        r.payee_email || '',
        r.payee_phone || '',
        (r.created_at ? new Date(r.created_at).toISOString() : '')
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) {
    next(e);
  }
}
