// app/services/paymentService.js
import db from "../core/db.js";
import crypto from "crypto";

function toRows(x) {
  return Array.isArray(x) && Array.isArray(x[0]) ? x[0] : x || [];
}
const rand = (n = 5) => crypto.randomBytes(n).toString("hex").slice(0, n);

function cleanText(v) {
  return String(v || "").trim();
}

function buildPublicUserFullName(row = {}) {
  return [row.first_name, row.middle_name, row.last_name]
    .map(cleanText)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveStudentPayee({ payee_id, payee_email, payee_phone } = {}) {
  const candidates = [payee_id, payee_email, payee_phone]
    .map(cleanText)
    .filter(Boolean);

  if (!candidates.length) return null;

  const placeholders = candidates.map(() => "?").join(",");
  const vals = [...candidates, ...candidates, ...candidates, ...candidates];

  const q = await db.query(
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
    WHERE LOWER(COALESCE(role, '')) = 'student'
      AND (
        matric_number IN (${placeholders})
        OR username IN (${placeholders})
        OR phone IN (${placeholders})
        OR CAST(id AS CHAR) IN (${placeholders})
      )
    ORDER BY
      CASE
        WHEN matric_number = ? THEN 1
        WHEN username = ? THEN 2
        WHEN phone = ? THEN 3
        ELSE 4
      END
    LIMIT 1
    `,
    [...vals, cleanText(payee_id), cleanText(payee_email), cleanText(payee_phone)]
  );

  const [row] = toRows(q);
  if (!row) return null;

  return {
    ...row,
    full_name: buildPublicUserFullName(row),
  };
}

// --- PUBLIC PAYMENT TYPES (for the public form) ---
export async function listActivePaymentTypes() {
  const q = await db.query(
    `SELECT id, name, purpose, amount, portal_charge, scope, is_active
     FROM payment_types
     WHERE is_active = 1
       AND UPPER(COALESCE(scope, 'GENERAL')) = 'GENERAL'
     ORDER BY name ASC`,
  );
  return toRows(q);
}
export async function getPaymentType(id) {
  const q = await db.query(`SELECT * FROM payment_types WHERE id=?`, [id]);
  const [row] = toRows(q);
  return row || null;
}

// --- ORDERS / INVOICES ---
export function makeOrderId() {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `INV-${ymd}-${rand(3)}${Date.now().toString().slice(-4)}`;
}

export async function createInvoice(payload) {
  const {
    payment_type_id,
    payee_id,
    payee_fullname,
    payee_email,
    payee_phone,
    purpose,
    amount: rawAmount,
    portal_charge_override: rawPortalChargeOverride,
    method,
  } = payload;

  const pt = await getPaymentType(payment_type_id);
  if (!pt) throw new Error("Invalid payment type selected.");

  const order_id = makeOrderId();

  const configuredAmount = Number(pt.amount || 0);
  const requestedAmount = Number(rawAmount);
  const amount =
    Number.isFinite(requestedAmount) && requestedAmount > 0
      ? requestedAmount
      : configuredAmount;

  const requestedPortalCharge = Number(rawPortalChargeOverride);
  const portal_charge =
    Number.isFinite(requestedPortalCharge) && requestedPortalCharge >= 0
      ? requestedPortalCharge
      : Number(pt.portal_charge || 0);

  const resolvedPayee = await resolveStudentPayee({
    payee_id,
    payee_email,
    payee_phone,
  });

  const resolvedPayeeId =
    cleanText(payee_id) ||
    cleanText(resolvedPayee?.matric_number) ||
    cleanText(resolvedPayee?.username);

  const resolvedPayeeFullname =
    cleanText(resolvedPayee?.full_name) || cleanText(payee_fullname);

  const resolvedPayeeEmail =
    cleanText(payee_email) || cleanText(resolvedPayee?.username);

  const resolvedPayeePhone =
    cleanText(payee_phone) || cleanText(resolvedPayee?.phone);

  const [ins] = await db.query(
    `INSERT INTO payment_invoices
      (order_id, payment_type_id, payee_id, payee_fullname, payee_email, payee_phone,
       purpose, amount, portal_charge, method, status)
     VALUES (?,?,?,?,?,?,?,?,?, ?, 'PENDING')`,
    [
      order_id,
      payment_type_id,
      resolvedPayeeId,
      resolvedPayeeFullname,
      resolvedPayeeEmail,
      resolvedPayeePhone,
      purpose || pt.purpose || null,
      amount,
      portal_charge,
      method === "BANK" ? "BANK" : "ONLINE",
    ],
  );

  return {
    id: ins.insertId,
    order_id,
    amount,
    portal_charge,
    pt,
    payee_id: resolvedPayeeId,
    payee_fullname: resolvedPayeeFullname,
    payee_email: resolvedPayeeEmail,
    payee_phone: resolvedPayeePhone,
  };
}

export async function attachRRR(order_id, rrr) {
  await db.query(`UPDATE payment_invoices SET rrr=? WHERE order_id=? LIMIT 1`, [
    rrr,
    order_id,
  ]);
}

export async function findInvoiceByOrder(order_id) {
  const q = await db.query(
    `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
     FROM payment_invoices inv
     LEFT JOIN payment_types pt ON pt.id=inv.payment_type_id
     WHERE inv.order_id=? LIMIT 1`,
    [order_id],
  );
  const [row] = toRows(q);
  return row || null;
}

export async function markPaid(order_id, extra = {}) {
  // If your table doesn't have paid_at or meta columns, this still works (ignored by MySQL).
  await db.query(
    `UPDATE payment_invoices
        SET status='PAID', paid_at=IFNULL(paid_at, NOW()), payment_meta=?
      WHERE order_id=? LIMIT 1`,
    [JSON.stringify(extra || {}), order_id],
  );
}

export async function refreshInvoice(order_id) {
  const q = await db.query(
    `SELECT inv.*, pt.name AS payment_type_name, pt.purpose AS payment_type_purpose
       FROM payment_invoices inv
       LEFT JOIN payment_types pt ON pt.id=inv.payment_type_id
      WHERE inv.order_id=? LIMIT 1`,
    [order_id],
  );
  const [row] = toRows(q);
  return row || null;
}

/* ================================
   ADMIN REPORTING
   listInvoices({ page, pageSize, q, from, to, status, method, typeId })
   ================================ */
export async function listInvoices(params = {}) {
  const page = Math.max(1, Number(params.page || 1));
  const exportAll = params.exportAll === true;
  const pageSize = exportAll
    ? Math.max(1, Number(params.pageSize || 100000))
    : Math.max(1, Math.min(100, Number(params.pageSize || 20)));
  const { q, from, to, status, method, typeId } = params;

  const where = [];
  const vals = [];

  if (q && q.trim()) {
    where.push(
      `(inv.order_id LIKE ?
        OR inv.rrr LIKE ?
        OR inv.payee_fullname LIKE ?
        OR inv.payee_id LIKE ?
        OR inv.payee_email LIKE ?
        OR COALESCE(pt.name, inv.purpose, '') LIKE ?)`,
    );
    const like = `%${q.trim()}%`;
    vals.push(like, like, like, like, like, like);
  }
  if (from) {
    where.push(`DATE(inv.created_at) >= ?`);
    vals.push(from);
  }
  if (to) {
    where.push(`DATE(inv.created_at) <= ?`);
    vals.push(to);
  }
  if (status && status !== "ALL") {
    where.push(`inv.status = ?`);
    vals.push(status);
  }
  if (method && method !== "ALL") {
    where.push(`inv.method = ?`);
    vals.push(method);
  }
  if (typeId && Number(typeId)) {
    where.push(`inv.payment_type_id = ?`);
    vals.push(Number(typeId));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // count total
  const cntQ = await db.query(
    `SELECT COUNT(*) AS c
       FROM payment_invoices inv
       LEFT JOIN payment_types pt ON pt.id=inv.payment_type_id
     ${whereSql}`,
    vals,
  );
  const total = toRows(cntQ)[0]?.c || 0;

  // rows (paged)
  // First paginate invoice IDs only. This prevents enrichment joins from reducing
  // the visible page size after duplicate removal.
  const offset = (page - 1) * pageSize;

  const idsQ = await db.query(
    `SELECT inv.id
       FROM payment_invoices inv
       LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
     ${whereSql}
     ORDER BY inv.created_at DESC, inv.id DESC
     LIMIT ? OFFSET ?`,
    [...vals, pageSize, offset],
  );

  const invoiceIds = toRows(idsQ)
    .map((row) => Number(row.id))
    .filter(Boolean);

  let rows = [];

  if (invoiceIds.length) {
    const idPlaceholders = invoiceIds.map(() => "?").join(",");

    const rowsQ = await db.query(
      `SELECT
          inv.*,
          COALESCE(pt.name, inv.purpose, 'School Fees') AS payment_type_name,
          COALESCE(pu.middle_name, '') AS student_middle_name,
          COALESCE(si.department, '') AS student_department,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name)), ''),
            inv.payee_fullname
          ) AS display_payee_fullname
         FROM payment_invoices inv
         LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
         LEFT JOIN public_users pu
           ON pu.id = (
             SELECT pu2.id
             FROM public_users pu2
             WHERE LOWER(COALESCE(pu2.role, '')) = 'student'
               AND (
                 pu2.matric_number COLLATE utf8mb4_unicode_ci = inv.payee_id COLLATE utf8mb4_unicode_ci
                 OR pu2.username COLLATE utf8mb4_unicode_ci = inv.payee_id COLLATE utf8mb4_unicode_ci
                 OR pu2.username COLLATE utf8mb4_unicode_ci = inv.payee_email COLLATE utf8mb4_unicode_ci
                 OR pu2.phone COLLATE utf8mb4_unicode_ci = inv.payee_phone COLLATE utf8mb4_unicode_ci
                 OR CAST(pu2.id AS CHAR) COLLATE utf8mb4_unicode_ci = inv.payee_id COLLATE utf8mb4_unicode_ci
               )
             ORDER BY
               CASE
                 WHEN pu2.matric_number COLLATE utf8mb4_unicode_ci = inv.payee_id COLLATE utf8mb4_unicode_ci THEN 1
                 WHEN pu2.username COLLATE utf8mb4_unicode_ci = inv.payee_email COLLATE utf8mb4_unicode_ci THEN 2
                 WHEN pu2.username COLLATE utf8mb4_unicode_ci = inv.payee_id COLLATE utf8mb4_unicode_ci THEN 3
                 WHEN pu2.phone COLLATE utf8mb4_unicode_ci = inv.payee_phone COLLATE utf8mb4_unicode_ci THEN 4
                 ELSE 5
               END
             LIMIT 1
           )
         LEFT JOIN (
           SELECT matric_number, MAX(department) AS department
           FROM student_imports
           WHERE matric_number IS NOT NULL AND matric_number <> ''
           GROUP BY matric_number
         ) si
           ON si.matric_number COLLATE utf8mb4_unicode_ci = COALESCE(NULLIF(pu.matric_number, ''), NULLIF(inv.payee_id, '')) COLLATE utf8mb4_unicode_ci
       WHERE inv.id IN (${idPlaceholders})
       ORDER BY FIELD(inv.id, ${idPlaceholders})`,
      [...invoiceIds, ...invoiceIds],
    );

    rows = toRows(rowsQ);
  }

  // summary
  const sumQ = await db.query(
    `SELECT
        SUM(CASE WHEN inv.status='PAID' THEN 1 ELSE 0 END)        AS paid_count,
        SUM(CASE WHEN inv.status<>'PAID' THEN 1 ELSE 0 END)       AS pending_count,
        SUM(CASE WHEN inv.method='ONLINE' THEN 1 ELSE 0 END)      AS online_count,
        SUM(CASE WHEN inv.method='BANK' THEN 1 ELSE 0 END)        AS bank_count
      FROM payment_invoices inv
      LEFT JOIN payment_types pt ON pt.id=inv.payment_type_id
     ${whereSql}`,
    vals,
  );
  const sum = toRows(sumQ)[0] || {
    paid_count: 0,
    pending_count: 0,
    online_count: 0,
    bank_count: 0,
  };

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
    },
  };
}
