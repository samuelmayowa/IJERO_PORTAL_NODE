// app/services/paymentService.js
import db from '../core/db.js';
import crypto from 'crypto';

function toRows(x){ return (Array.isArray(x) && Array.isArray(x[0])) ? x[0] : (x || []); }
const rand = (n=5)=> crypto.randomBytes(n).toString('hex').slice(0, n);

// --- PUBLIC PAYMENT TYPES (for the public form) ---
export async function listActivePaymentTypes() {
  const q = await db.query(
    `SELECT id, name, purpose, amount, portal_charge, scope, is_active
     FROM payment_types
     WHERE is_active=1
     ORDER BY name ASC`
  );
  return toRows(q);
}

export async function getPaymentType(id){
  const q = await db.query(`SELECT * FROM payment_types WHERE id=?`, [id]);
  const [row] = toRows(q);
  return row || null;
}

// --- ORDERS / INVOICES ---
export function makeOrderId() {
  const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
  return `INV-${ymd}-${rand(3)}${Date.now().toString().slice(-4)}`;
}

export async function createInvoice(payload){
  const {
    payment_type_id,
    payee_id, payee_fullname, payee_email, payee_phone,
    purpose, method
  } = payload;

  const pt = await getPaymentType(payment_type_id);
  if (!pt) throw new Error('Invalid payment type selected.');

  const order_id = makeOrderId();
  const amount = Number(pt.amount || 0);
  const portal_charge = Number(pt.portal_charge || 0);

  const [ins] = await db.query(
    `INSERT INTO payment_invoices
      (order_id, payment_type_id, payee_id, payee_fullname, payee_email, payee_phone,
       purpose, amount, portal_charge, method, status)
     VALUES (?,?,?,?,?,?,?,?,?, ?, 'PENDING')`,
    [order_id, payment_type_id, payee_id, payee_fullname, payee_email, payee_phone,
     (purpose || pt.purpose || null), amount, portal_charge, method === 'BANK' ? 'BANK' : 'ONLINE']
  );

  return { id: ins.insertId, order_id, amount, portal_charge, pt };
}

export async function attachRRR(order_id, rrr){
  await db.query(`UPDATE payment_invoices SET rrr=? WHERE order_id=? LIMIT 1`, [rrr, order_id]);
}

export async function findInvoiceByOrder(order_id){
  const q = await db.query(
    `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
     FROM payment_invoices inv
     JOIN payment_types pt ON pt.id=inv.payment_type_id
     WHERE inv.order_id=? LIMIT 1`, [order_id]);
  const [row] = toRows(q);
  return row || null;
}

export async function markPaid(order_id, extra = {}){
  // If your table doesn't have paid_at or meta columns, this still works (ignored by MySQL).
  await db.query(
    `UPDATE payment_invoices
        SET status='PAID', paid_at=IFNULL(paid_at, NOW()), payment_meta=?
      WHERE order_id=? LIMIT 1`,
    [JSON.stringify(extra || {}), order_id]
  );
}

export async function refreshInvoice(order_id){
  const q = await db.query(
    `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
       FROM payment_invoices inv
       JOIN payment_types pt ON pt.id=inv.payment_type_id
      WHERE inv.order_id=? LIMIT 1`,
    [order_id]
  );
  const [row] = toRows(q);
  return row || null;
}

/* ================================
   ADMIN REPORTING
   listInvoices({ page, pageSize, q, from, to, status, method, typeId })
   ================================ */
export async function listInvoices(params = {}){
  const page     = Math.max(1, Number(params.page || 1));
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize || 20)));
  const { q, from, to, status, method, typeId } = params;

  const where = [];
  const vals  = [];

  if (q && q.trim()){
    where.push(`(inv.order_id LIKE ? OR inv.payee_fullname LIKE ? OR inv.payee_id LIKE ? OR pt.name LIKE ?)`);
    const like = `%${q.trim()}%`;
    vals.push(like, like, like, like);
  }
  if (from){
    where.push(`DATE(inv.created_at) >= ?`);
    vals.push(from);
  }
  if (to){
    where.push(`DATE(inv.created_at) <= ?`);
    vals.push(to);
  }
  if (status && status !== 'ALL'){
    where.push(`inv.status = ?`);
    vals.push(status);
  }
  if (method && method !== 'ALL'){
    where.push(`inv.method = ?`);
    vals.push(method);
  }
  if (typeId && Number(typeId)){
    where.push(`inv.payment_type_id = ?`);
    vals.push(Number(typeId));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // count total
  const cntQ = await db.query(
    `SELECT COUNT(*) AS c
       FROM payment_invoices inv
       JOIN payment_types pt ON pt.id=inv.payment_type_id
     ${whereSql}`, vals
  );
  const total = toRows(cntQ)[0]?.c || 0;

  // rows (paged)
  const offset = (page - 1) * pageSize;
  const rowsQ = await db.query(
    `SELECT inv.*, pt.name AS payment_type_name
       FROM payment_invoices inv
       JOIN payment_types pt ON pt.id=inv.payment_type_id
     ${whereSql}
     ORDER BY inv.created_at DESC
     LIMIT ? OFFSET ?`,
    [...vals, pageSize, offset]
  );
  const rows = toRows(rowsQ);

  // summary
  const sumQ = await db.query(
    `SELECT
        SUM(CASE WHEN inv.status='PAID' THEN 1 ELSE 0 END)        AS paid_count,
        SUM(CASE WHEN inv.status<>'PAID' THEN 1 ELSE 0 END)       AS pending_count,
        SUM(CASE WHEN inv.method='ONLINE' THEN 1 ELSE 0 END)      AS online_count,
        SUM(CASE WHEN inv.method='BANK' THEN 1 ELSE 0 END)        AS bank_count
      FROM payment_invoices inv
      JOIN payment_types pt ON pt.id=inv.payment_type_id
     ${whereSql}`,
    vals
  );
  const sum = toRows(sumQ)[0] || { paid_count:0, pending_count:0, online_count:0, bank_count:0 };

  return {
    rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    summary: {
      total,
      paid: Number(sum.paid_count || 0),
      pending: Number(sum.pending_count || 0),
      online: Number(sum.online_count || 0),
      bank: Number(sum.bank_count || 0),
    }
  };
}
