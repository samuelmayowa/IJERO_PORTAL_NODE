// app/web/controllers/bursaryPaymentVerification.controller.js
import db from "../../core/db.js";
import * as remita from "../../services/remitaService.js";
import * as svc from "../../services/paymentService.js";

function toRows(x) {
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

function money(n) {
  const v = Number(n || 0);
  return `₦${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeDateInput(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function humanDateTime(v) {
  if (!v) return "N/A";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function parseMeta(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildReportWhere(filters = {}) {
  const where = ["1=1"];
  const params = [];

  if (filters.from) {
    where.push("DATE(COALESCE(inv.paid_at, inv.created_at)) >= ?");
    params.push(filters.from);
  }

  if (filters.to) {
    where.push("DATE(COALESCE(inv.paid_at, inv.created_at)) <= ?");
    params.push(filters.to);
  }

  if (filters.q) {
    const like = `%${filters.q}%`;
    where.push(`(
      inv.order_id LIKE ?
      OR inv.rrr LIKE ?
      OR inv.payee_id LIKE ?
      OR inv.payee_fullname LIKE ?
      OR inv.payee_email LIKE ?
      OR inv.payee_phone LIKE ?
      OR inv.purpose LIKE ?
      OR pt.name LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like, like);
  }

  return { whereSql: where.join(" AND "), params };
}

async function loadReport(filters = {}) {
  const { whereSql, params } = buildReportWhere(filters);

  const rowsQ = await db.query(
    `
      SELECT
        inv.id,
        inv.order_id,
        inv.rrr,
        inv.payment_type_id,
        inv.payee_id,
        inv.payee_fullname,
        inv.payee_email,
        inv.payee_phone,
        inv.purpose,
        inv.amount,
        inv.portal_charge,
        (COALESCE(inv.amount, 0) + COALESCE(inv.portal_charge, 0)) AS total_amount,
        inv.method,
        inv.status,
        inv.paid_at,
        inv.created_at,
        COALESCE(inv.paid_at, inv.created_at) AS txn_date,
        pt.name AS payment_type_name,
        pt.purpose AS payment_type_purpose
      FROM payment_invoices inv
      LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
      WHERE ${whereSql}
      ORDER BY COALESCE(inv.paid_at, inv.created_at) DESC
      LIMIT 250
    `,
    params,
  );

  const sumQ = await db.query(
    `
      SELECT
        SUM(CASE WHEN inv.status = 'PAID' THEN 1 ELSE 0 END) AS paid_count,
        COALESCE(
          SUM(
            CASE
              WHEN inv.status = 'PAID'
              THEN (COALESCE(inv.amount, 0) + COALESCE(inv.portal_charge, 0))
              ELSE 0
            END
          ),
          0
        ) AS paid_total,
        SUM(CASE WHEN inv.status IN ('FAILED', 'CANCELLED') THEN 1 ELSE 0 END) AS failed_count,
        COALESCE(
          SUM(
            CASE
              WHEN inv.status IN ('FAILED', 'CANCELLED')
              THEN (COALESCE(inv.amount, 0) + COALESCE(inv.portal_charge, 0))
              ELSE 0
            END
          ),
          0
        ) AS failed_total
      FROM payment_invoices inv
      LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
      WHERE ${whereSql}
    `,
    params,
  );

  const rows = toRows(rowsQ);
  const summaryRow = toRows(sumQ)[0] || {};

  return {
    rows,
    summary: {
      paid_count: Number(summaryRow.paid_count || 0),
      paid_total: Number(summaryRow.paid_total || 0),
      failed_count: Number(summaryRow.failed_count || 0),
      failed_total: Number(summaryRow.failed_total || 0),
    },
  };
}

async function getInvoiceByReference(reference) {
  const rawRef = String(reference || "").trim();
  const compactRef = rawRef.replace(/[-\s]/g, "");

  const q = await db.query(
    `
      SELECT
        inv.id,
        inv.order_id,
        inv.rrr,
        inv.payment_type_id,
        inv.payee_id,
        inv.payee_fullname,
        inv.payee_email,
        inv.payee_phone,
        inv.purpose,
        inv.amount,
        inv.portal_charge,
        (COALESCE(inv.amount, 0) + COALESCE(inv.portal_charge, 0)) AS total_amount,
        inv.method,
        inv.status,
        inv.paid_at,
        inv.created_at,
        inv.payment_meta,
        pt.name AS payment_type_name,
        pt.purpose AS payment_type_purpose
      FROM payment_invoices inv
      LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
      WHERE
        inv.order_id = ?
        OR inv.rrr = ?
        OR REPLACE(inv.order_id, '-', '') = ?
        OR REPLACE(inv.rrr, '-', '') = ?
      LIMIT 1
    `,
    [rawRef, rawRef, compactRef, compactRef],
  );

  return toRows(q)[0] || null;
}

async function refreshInvoice(orderId) {
  return getInvoiceByReference(orderId);
}

async function tryRemitaVerification(inv) {
  if (!inv || String(inv.status || "").toUpperCase() === "PAID") return inv;

  try {
    const status = inv.rrr
      ? await remita.verifyByRRR(String(inv.rrr))
      : await remita.verifyByOrderId(String(inv.order_id));

    const code = String(
      status?.status ||
        status?.responseCode ||
        status?.message ||
        status?.statuscode ||
        "",
    );

    const msg = String(
      status?.statusMessage ||
        status?.statusmessage ||
        status?.responseMessage ||
        "",
    );

    const paid =
      /(^00$)|(^01$)/.test(code) ||
      /success|approved/i.test(code) ||
      /success|approved/i.test(msg);

    if (paid) {
      await svc.markPaid(String(inv.order_id), {
        remita: status,
        rrr: inv.rrr || undefined,
      });
      return await refreshInvoice(inv.order_id);
    }
  } catch (err) {
    console.error("[bursary payment verify]", err);
  }

  return inv;
}

async function getDailyInflows(inv) {
  const day = normalizeDateInput(inv?.paid_at || inv?.created_at);
  if (!day) {
    return {
      day: "",
      payment_day_total: 0,
      payment_day_count: 0,
      overall_day_total: 0,
      overall_day_count: 0,
    };
  }

  const samePaymentQ = await db.query(
    `
      SELECT
        COALESCE(SUM(COALESCE(amount, 0) + COALESCE(portal_charge, 0)), 0) AS payment_day_total,
        COUNT(*) AS payment_day_count
      FROM payment_invoices
      WHERE status = 'PAID'
        AND DATE(COALESCE(paid_at, created_at)) = ?
        AND payment_type_id <=> ?
    `,
    [day, inv.payment_type_id ?? null],
  );

  const overallQ = await db.query(
    `
      SELECT
        COALESCE(SUM(COALESCE(amount, 0) + COALESCE(portal_charge, 0)), 0) AS overall_day_total,
        COUNT(*) AS overall_day_count
      FROM payment_invoices
      WHERE status = 'PAID'
        AND DATE(COALESCE(paid_at, created_at)) = ?
    `,
    [day],
  );

  const samePayment = toRows(samePaymentQ)[0] || {};
  const overall = toRows(overallQ)[0] || {};

  return {
    day,
    payment_day_total: Number(samePayment.payment_day_total || 0),
    payment_day_count: Number(samePayment.payment_day_count || 0),
    overall_day_total: Number(overall.overall_day_total || 0),
    overall_day_count: Number(overall.overall_day_count || 0),
  };
}

export async function renderVerifyPage(req, res, next) {
  try {
    const filters = {
      from: normalizeDateInput(req.query.from),
      to: normalizeDateInput(req.query.to),
      q: String(req.query.q || "").trim(),
    };

    const report = await loadReport(filters);

    res.render("pages/staff/bursary-payment-verification", {
      title: "Bursary Payment Verification",
      filters,
      rows: report.rows,
      summary: report.summary,
      csrfToken: req.csrfToken?.() || null,
    });
  } catch (err) {
    next(err);
  }
}

export async function confirmPayment(req, res, next) {
  try {
    const reference = String(
      req.body.reference || req.body.rrr || req.body.order_id || "",
    ).trim();

    if (!reference) {
      return res.status(400).json({
        ok: false,
        error: "Enter an RRR or Invoice Number.",
      });
    }

    let inv = await getInvoiceByReference(reference);
    if (!inv) {
      return res.status(404).json({
        ok: false,
        error: "No payment record was found for that RRR / Invoice Number.",
      });
    }

    inv = await tryRemitaVerification(inv);
    const daily = await getDailyInflows(inv);

    const statusUpper = String(inv.status || "").toUpperCase();
    const paymentLabel = inv.payment_type_name || inv.purpose || "this payment";
    const paidOn = inv.paid_at || inv.created_at;

    let message =
      `No successful payment has been confirmed yet for this record. ` +
      `Current status is ${statusUpper || "UNKNOWN"}.`;

    if (statusUpper === "PAID") {
      message =
        `This amount was paid and successful by ${inv.payee_fullname || "the payer"} ` +
        `on ${humanDateTime(paidOn)}. ` +
        `This makes the total inflow for ${paymentLabel} on ${daily.day || "that date"} ` +
        `to ${money(daily.payment_day_total)}. ` +
        `Overall successful inflow for the day is ${money(daily.overall_day_total)}.`;
    }

    const meta = parseMeta(inv.payment_meta);
    const metaPretty = !meta
      ? ""
      : typeof meta === "string"
        ? meta
        : JSON.stringify(meta, null, 2);

    const kind = statusUpper === "PAID" ? "receipt" : "invoice";
    const viewUrl = `/payment/print/${encodeURIComponent(inv.order_id)}?type=${kind}&dl=0`;

    return res.json({
      ok: true,
      message,
      payment: {
        ...inv,
        payment_meta_pretty: metaPretty,
      },
      summary: daily,
      view_url: viewUrl,
    });
  } catch (err) {
    next(err);
  }
}
