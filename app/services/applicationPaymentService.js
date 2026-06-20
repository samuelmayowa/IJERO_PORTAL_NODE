import crypto from "crypto";
import db from "../core/db.js";
import * as paymentService from "./paymentService.js";
import {
  syncApplicationPaymentByOrderId,
} from "./applicationPaymentSyncService.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizePayerPhone(value) {
  let digits = String(value ?? "")
    .trim()
    .replace(/\D+/g, "");

  // Convert +2348012345678 or 2348012345678 to 08012345678.
  if (digits.startsWith("234") && digits.length === 13) {
    digits = `0${digits.slice(3)}`;
  }

  // Convert 8012345678 to 08012345678.
  if (digits.length === 10 && !digits.startsWith("0")) {
    digits = `0${digits}`;
  }

  return digits;
}

function makeApplicationNumber(form) {
  const year = new Date().getFullYear();
  const code = clean(form?.code)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 18);

  const random = crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();

  return `APP-${year}-${code || "FORM"}-${random}`;
}

function applicantFullName(applicant) {
  return [
    applicant?.first_name,
    applicant?.middle_name,
    applicant?.last_name,
  ]
    .map(clean)
    .filter(Boolean)
    .join(" ");
}

function applicantEmail(applicant) {
  const username = clean(applicant?.username);

  if (username.includes("@")) return username;

  return "no-reply@ekscotech.edu.ng";
}

async function loadPaymentType(id) {
  const [rows] = await db.query(
    `
      SELECT *
      FROM payment_types
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
    `,
    [id],
  );

  return rows?.[0] || null;
}

export async function loadApplicationProgress(
  formId,
  applicantUserId,
) {
  const [rows] = await db.query(
    `
      SELECT
        aa.*,
        pi.order_id,
        pi.rrr,
        pi.amount AS invoice_amount,
        pi.portal_charge AS invoice_portal_charge,
        pi.status AS invoice_status,
        pi.created_at AS invoice_created_at
      FROM applicant_applications aa
      LEFT JOIN payment_invoices pi
        ON pi.id = aa.application_invoice_id
      WHERE aa.application_form_id = ?
        AND aa.applicant_user_id = ?
      ORDER BY aa.id DESC
      LIMIT 1
    `,
    [formId, applicantUserId],
  );

  const application = rows?.[0] || null;
  if (!application) return null;

  if (
    application.order_id &&
    clean(application.invoice_status).toUpperCase() ===
      "PAID" &&
    clean(application.application_payment_status).toUpperCase() !==
      "PAID"
  ) {
    await syncApplicationPaymentByOrderId(
      application.order_id,
    );

    return loadApplicationProgress(
      formId,
      applicantUserId,
    );
  }

  const [paymentLines] = await db.query(
    `
      SELECT
        id,
        charge_name,
        charge_stage,
        amount,
        payment_status
      FROM application_payment_lines
      WHERE applicant_application_id = ?
      ORDER BY charge_stage, id
    `,
    [application.id],
  );

  let formData = {};

  try {
    formData = application.form_data
      ? JSON.parse(application.form_data)
      : {};
  } catch {
    formData = {};
  }

  return {
    ...application,
    form_data_object: formData,
    payment_lines: paymentLines || [],
  };
}

async function createApplicationRecord({
  form,
  applicant,
  verifiedRecord,
}) {
  const applicationCharges =
    Array.isArray(form.application_charges)
      ? form.application_charges
      : [];

  const applicationTotal = applicationCharges.reduce(
    (sum, charge) => sum + money(charge.amount),
    0,
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const snapshot = {
      source: "application_portal",
      application_form_id: form.id,
      application_code: form.code,
      application_title: form.title,
      category: form.category,
      session_id: form.session_id,
      verified_prerequisite: verifiedRecord || null,
    };

    const [applicationResult] =
      await connection.query(
        `
          INSERT INTO applicant_applications
            (
              application_form_id,
              applicant_user_id,
              application_number,
              form_data,
              application_payment_status,
              status
            )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          form.id,
          applicant.id,
          makeApplicationNumber(form),
          JSON.stringify(snapshot),
          applicationTotal > 0
            ? "UNPAID"
            : "NOT_REQUIRED",
          applicationTotal > 0
            ? "AWAITING_PAYMENT"
            : "IN_PROGRESS",
        ],
      );

    for (const charge of applicationCharges) {
      const amount = money(charge.amount);

      await connection.query(
        `
          INSERT INTO application_payment_lines
            (
              applicant_application_id,
              application_form_charge_id,
              charge_stage,
              charge_name,
              amount,
              payment_status
            )
          VALUES (?, ?, 'APPLICATION', ?, ?, ?)
        `,
        [
          applicationResult.insertId,
          charge.id || null,
          clean(charge.charge_name),
          amount,
          amount <= 0 ? "NO_CHARGE" : "UNPAID",
        ],
      );
    }

    if (applicationTotal <= 0) {
      await connection.query(
        `
          UPDATE application_prerequisites
          SET match_status = 'USED'
          WHERE application_form_id = ?
            AND matched_applicant_user_id = ?
            AND match_status IN ('MATCHED', 'USED')
        `,
        [form.id, applicant.id],
      );
    }

    await connection.commit();

    return {
      id: applicationResult.insertId,
      application_total: applicationTotal,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureApplicationInvoice({
  application,
  form,
  applicant,
}) {
  if (application.application_invoice_id) {
    const [invoiceRows] = await db.query(
      `
        SELECT *
        FROM payment_invoices
        WHERE id = ?
        LIMIT 1
      `,
      [application.application_invoice_id],
    );

    const existingInvoice = invoiceRows?.[0] || null;

    if (existingInvoice) {
      const paymentType = await loadPaymentType(
        form.application_payment_type_id,
      );

      const serviceTypeId = clean(
        paymentType?.remita_service_type_id ||
          process.env.REMITA_STID_APPLICATION_FORM,
      );

      if (!serviceTypeId) {
        throw new Error(
          "Application Remita Service Type ID is not configured.",
        );
      }

      return existingInvoice;
    }
  }

  const paymentType = await loadPaymentType(
    form.application_payment_type_id,
  );

  if (!paymentType) {
    throw new Error(
      "The application payment type is not configured.",
    );
  }

  const serviceTypeId = clean(
    paymentType.remita_service_type_id ||
      process.env.REMITA_STID_APPLICATION_FORM,
  );

  if (!serviceTypeId) {
    throw new Error(
      "Application Remita Service Type ID is not configured.",
    );
  }

  const total = money(application.application_total);

  const created = await paymentService.createInvoice({
    payment_type_id: paymentType.id,
    payee_id:
      clean(applicant.username) ||
      String(applicant.id),
    payee_fullname:
      applicantFullName(applicant) || "Applicant",
    payee_email: applicantEmail(applicant),
    payee_phone:
      normalizePayerPhone(applicant.phone) ||
      "00000000000",
    purpose:
      `${clean(form.title)} - Application Charges`,
    amount: total,
    portal_charge_override: 0,
    method: "BANK",
  });

  await db.query(
    `
      UPDATE payment_invoices
      SET
        remita_service_type_id = ?,
        created_by = ?
      WHERE id = ?
    `,
    [
      serviceTypeId,
      applicant.id || null,
      created.id,
    ],
  );

  await db.query(
    `
      UPDATE applicant_applications
      SET
        application_invoice_id = ?,
        application_payment_status = 'PENDING',
        status = 'AWAITING_PAYMENT'
      WHERE id = ?
    `,
    [created.id, application.id],
  );

  await db.query(
    `
      UPDATE application_payment_lines
      SET
        invoice_id = ?,
        payment_status = CASE
          WHEN amount <= 0 THEN 'NO_CHARGE'
          ELSE 'PENDING'
        END
      WHERE applicant_application_id = ?
        AND charge_stage = 'APPLICATION'
    `,
    [created.id, application.id],
  );

  return {
    id: created.id,
    order_id: created.order_id,
    amount: created.amount,
    portal_charge: created.portal_charge,
    rrr: null,
    status: "PENDING",
  };
}

export async function startOrResumeApplication({
  form,
  applicant,
  verifiedRecord,
}) {
  let progress = await loadApplicationProgress(
    form.id,
    applicant.id,
  );

  const mayCreateAnother =
    Number(form.allow_multiple_applications) === 1 &&
    progress &&
    [
      "SUBMITTED",
      "ADMITTED",
      "REJECTED",
      "WITHDRAWN",
    ].includes(clean(progress.status).toUpperCase());

  if (!progress || mayCreateAnother) {
    const created = await createApplicationRecord({
      form,
      applicant,
      verifiedRecord,
    });

    progress = await loadApplicationProgress(
      form.id,
      applicant.id,
    );

    progress.application_total =
      created.application_total;
  }

  const applicationTotal = (
    progress.payment_lines || []
  )
    .filter(
      (line) => line.charge_stage === "APPLICATION",
    )
    .reduce(
      (sum, line) => sum + money(line.amount),
      0,
    );

  if (
    applicationTotal <= 0 ||
    progress.application_payment_status ===
      "NOT_REQUIRED" ||
    progress.application_payment_status === "PAID"
  ) {
    return {
      kind: "FORM",
      progress: await loadApplicationProgress(
        form.id,
        applicant.id,
      ),
    };
  }

  const invoice = await ensureApplicationInvoice({
    application: {
      ...progress,
      application_total: applicationTotal,
    },
    form,
    applicant,
  });

  return {
    kind: "PAYMENT",
    invoice,
    progress: await loadApplicationProgress(
      form.id,
      applicant.id,
    ),
  };
}
