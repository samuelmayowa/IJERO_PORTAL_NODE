import { pool } from "../../core/db.js";

const LEGACY_SESSION = "2025/2026";

function normalize(value) {
  return String(value || "").trim();
}

function legacyOrderId(row) {
  const raw = normalize(row.order_id);
  return raw || `LEGACY-${row.pay_id}`;
}

function legacyMeta(row) {
  return JSON.stringify({
    source: "legacy_student_payments",
    legacy_session: LEGACY_SESSION,
    legacy_pay_id: row.pay_id,
    legacy_student_id: row.student_id,
    legacy_matric_id: row.matric_id,
    legacy_ref_number: row.ref_number,
    legacy_order_id: row.order_id || null,
    legacy_pay_type: row.pay_type,
    imported_by: "legacy_payment_recovery",
  });
}

async function findMissingLegacyPayments({
  matric = "",
  email = "",
  limit = 500,
} = {}) {
  const where = [
    `oldp.status = 'Successful'`,
    `oldp.academic_session = ?`,
    `LOWER(TRIM(oldp.pay_type)) = 'school fees'`,
    `NOT EXISTS (
      SELECT 1
      FROM payment_invoices pi
      WHERE pi.order_id = CASE
        WHEN oldp.order_id IS NULL OR TRIM(oldp.order_id) = ''
          THEN CONCAT('LEGACY-', oldp.pay_id)
        ELSE oldp.order_id
      END
      OR (
        NULLIF(TRIM(oldp.ref_number), '') IS NOT NULL
        AND TRIM(pi.rrr) = TRIM(oldp.ref_number)
      )
    )`,
  ];

  const params = [LEGACY_SESSION];

  if (matric) {
    where.push(`oldp.matric_id = ?`);
    params.push(matric);
  }

  if (email) {
    where.push(`LOWER(pu.username) = LOWER(?)`);
    params.push(email);
  }

  params.push(Number(limit) || 500);

  const [rows] = await pool.query(
    `
    SELECT
      oldp.pay_id,
      oldp.student_id,
      oldp.matric_id,
      oldp.pay_type,
      oldp.amount_paid,
      oldp.ref_number,
      oldp.order_id,
      oldp.amount_payable,
      oldp.date_paid,
      oldp.status AS legacy_status,
      oldp.std_level,
      oldp.academic_session,
      pu.id AS public_user_id,
      pu.matric_number,
      pu.username AS email,
      pu.phone,
      CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS student_name
    FROM legacy_student_payments oldp
    JOIN public_users pu
      ON pu.matric_number = oldp.matric_id
     AND pu.role = 'student'
    WHERE ${where.join(" AND ")}
    ORDER BY oldp.date_paid ASC, oldp.pay_id ASC
    LIMIT ?
    `,
    params,
  );

  return rows || [];
}

export async function page(_req, res) {
  res.render("pages/staff/legacy-payment-recovery", {
    title: "Legacy Payment Recovery",
    pageTitle: "Legacy Payment Recovery",
    csrfToken: res.locals.csrfToken || "",
  });
}

export async function preview(req, res) {
  try {
    const mode = normalize(req.query.mode || "single");
    const matric = normalize(req.query.matric);
    const email = normalize(req.query.email).toLowerCase();

    if (mode === "single" && !matric && !email) {
      return res.json({
        success: false,
        items: [],
        total: 0,
        totalAmount: 0,
        message: "Enter student matric number or email.",
      });
    }

    const rows = await findMissingLegacyPayments({
      matric,
      email,
      limit: mode === "bulk" ? 1000 : 100,
    });

    const totalAmount = rows.reduce(
      (sum, row) => sum + Number(row.amount_paid || 0),
      0,
    );

    return res.json({
      success: true,
      items: rows,
      total: rows.length,
      totalAmount,
    });
  } catch (err) {
    console.error("legacy payment preview error:", err);
    return res.status(500).json({
      success: false,
      items: [],
      total: 0,
      totalAmount: 0,
      message: err.message || "Could not preview legacy payments.",
    });
  }
}

export async function importPayments(req, res) {
  const conn = await pool.getConnection();

  try {
    const mode = normalize(req.body.mode || "single");
    const matric = normalize(req.body.matric);
    const email = normalize(req.body.email).toLowerCase();

    if (mode === "single" && !matric && !email) {
      return res.status(400).json({
        success: false,
        message: "Enter student matric number or email.",
      });
    }

    const rows = await findMissingLegacyPayments({
      matric,
      email,
      limit: mode === "bulk" ? 1000 : 100,
    });

    if (!rows.length) {
      return res.json({
        success: true,
        imported: 0,
        totalAmount: 0,
        message: "No missing successful legacy payment found for import.",
      });
    }

    await conn.beginTransaction();

    let imported = 0;
    let skipped = 0;
    let totalAmount = 0;

    for (const row of rows) {
      const orderId = legacyOrderId(row);
      const amount = Number(row.amount_paid || 0);

      const rrr = normalize(row.ref_number);

      const [existing] = await conn.query(
        `
        SELECT id
        FROM payment_invoices
        WHERE order_id = ?
           OR (
             ? <> ''
             AND TRIM(rrr) = ?
           )
        LIMIT 1
        `,
        [orderId, rrr, rrr],
      );

      if (existing.length) {
        skipped += 1;
        continue;
      }

      await conn.query(
        `
        INSERT INTO payment_invoices
          (
            order_id,
            rrr,
            payment_type_id,
            fee_regime,
            remita_service_type_id,
            payee_id,
            payee_fullname,
            payee_email,
            payee_phone,
            purpose,
            amount,
            portal_charge,
            method,
            status,
            paid_at,
            payment_meta,
            created_by,
            created_at
          )
        VALUES
          (?, ?, 0, NULL, NULL, ?, ?, ?, ?, 'School Fees', ?, 0, 'BANK', 'PAID', ?, ?, NULL, NOW())
        `,
        [
          orderId,
          normalize(row.ref_number) || null,
          normalize(row.matric_number) ||
            normalize(row.email) ||
            String(row.public_user_id),
          normalize(row.student_name),
          normalize(row.email) || null,
          normalize(row.phone) || null,
          amount,
          row.date_paid,
          legacyMeta(row),
        ],
      );

      imported += 1;
      totalAmount += amount;
    }

    await conn.commit();

    return res.json({
      success: true,
      imported,
      skipped,
      totalAmount,
      message: `${imported} successful payment(s) brought forward from the old portal. Please tell the affected student(s) to log in again; their payment dashboard should now be up to date.`,
    });
  } catch (err) {
    await conn.rollback();
    console.error("legacy payment import error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Could not import legacy payments.",
    });
  } finally {
    conn.release();
  }
}
