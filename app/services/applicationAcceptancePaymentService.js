import db from "../core/db.js";
import {
  createInvoice,
  getPaymentType,
} from "./paymentService.js";

function clean(value) {
  return String(value ?? "").trim();
}

function resolveAcceptanceServiceTypeId(paymentType) {
  const mode =
    clean(process.env.REMITA_MODE).toLowerCase() ===
    "live"
      ? "LIVE"
      : "TEST";

  return clean(
    paymentType?.remita_service_type_id ||
    process.env[
      `REMITA_${mode}_STID_ACCEPTANCE_FEE`
    ] ||
    process.env.REMITA_STID_ACCEPTANCE_FEE,
  );
}

function money(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fullName(applicant) {
  return [
    applicant?.first_name,
    applicant?.middle_name,
    applicant?.last_name,
  ]
    .map(clean)
    .filter(Boolean)
    .join(" ");
}

function emailAddress(applicant) {
  const username = clean(applicant?.username);

  return (
    clean(applicant?.email) ||
    (username.includes("@") ? username : "") ||
    "no-reply@ekscotech.edu.ng"
  );
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D+/g, "");

  if (digits.startsWith("234") && digits.length === 13) {
    digits = `0${digits.slice(3)}`;
  }

  if (digits.length === 10 && !digits.startsWith("0")) {
    digits = `0${digits}`;
  }

  return digits || "00000000000";
}

export async function listAcceptanceApplications(
  applicantUserId,
) {
  const [rows] = await db.query(
    `
      SELECT
        aa.id,
        aa.application_number,
        aa.status AS application_status,
        aa.acceptance_payment_status,
        aa.acceptance_invoice_id,
        aa.created_at,
        aa.submitted_at,

        af.title AS application_title,
        af.slug AS application_slug,
        af.category,
        af.acceptance_payment_type_id,
        apt.name AS acceptance_payment_type,
        apt.is_active AS acceptance_payment_type_active,
        apt.remita_service_type_id AS database_acceptance_stid,

        pi.order_id,
        pi.rrr,
        pi.amount,
        pi.portal_charge,
        pi.status AS invoice_status,
        pi.method,
        pi.created_at AS invoice_created_at,
        pi.paid_at,

        COALESCE(
          (
            SELECT SUM(afc.amount)
            FROM application_form_charges afc
            WHERE afc.application_form_id =
              aa.application_form_id
              AND afc.charge_stage = 'ACCEPTANCE'
              AND afc.is_active = 1
          ),
          0
        ) AS configured_acceptance_total
      FROM applicant_applications aa
      JOIN application_forms af
        ON af.id = aa.application_form_id
      LEFT JOIN payment_types apt
        ON apt.id = af.acceptance_payment_type_id
      LEFT JOIN payment_invoices pi
        ON pi.id = aa.acceptance_invoice_id
      WHERE aa.applicant_user_id = ?
        AND (
          aa.status = 'ADMITTED'
          OR aa.acceptance_payment_status IN (
            'PENDING',
            'PAID'
          )
        )
      ORDER BY aa.id DESC
    `,
    [applicantUserId],
  );

  const fallbackAcceptanceStid =
    resolveAcceptanceServiceTypeId(null);

  return (rows || []).map((row) => ({
    ...row,
    acceptance_stid:
      clean(row.acceptance_stid) ||
      fallbackAcceptanceStid,
  }));
}

async function replaceAcceptanceLines({
  connection,
  applicantApplicationId,
  applicationFormId,
  invoiceId,
}) {
  const [charges] = await connection.query(
    `
      SELECT
        id,
        charge_name,
        amount
      FROM application_form_charges
      WHERE application_form_id = ?
        AND charge_stage = 'ACCEPTANCE'
        AND is_active = 1
      ORDER BY display_order, id
    `,
    [applicationFormId],
  );

  const total = charges.reduce(
    (sum, charge) => sum + money(charge.amount),
    0,
  );

  if (total <= 0) {
    throw new Error(
      "No payable acceptance charge has been configured for this application.",
    );
  }

  await connection.query(
    `
      DELETE FROM application_payment_lines
      WHERE applicant_application_id = ?
        AND charge_stage = 'ACCEPTANCE'
    `,
    [applicantApplicationId],
  );

  for (const charge of charges) {
    const amount = money(charge.amount);

    await connection.query(
      `
        INSERT INTO application_payment_lines
          (
            applicant_application_id,
            application_form_charge_id,
            invoice_id,
            charge_stage,
            charge_name,
            amount,
            payment_status
          )
        VALUES (?, ?, ?, 'ACCEPTANCE', ?, ?, ?)
      `,
      [
        applicantApplicationId,
        charge.id,
        invoiceId,
        clean(charge.charge_name),
        amount,
        amount > 0 ? "PENDING" : "NO_CHARGE",
      ],
    );
  }

  return {
    charges,
    total,
  };
}

export async function startOrResumeAcceptancePayment({
  applicationId,
  applicant,
}) {
  const applicantUserId = Number(applicant?.id);

  if (!applicantUserId) {
    throw new Error(
      "The applicant account could not be identified.",
    );
  }

  const [applicationRows] = await db.query(
    `
      SELECT
        aa.*,
        af.title AS application_title,
        af.slug AS application_slug,
        af.acceptance_payment_type_id
      FROM applicant_applications aa
      JOIN application_forms af
        ON af.id = aa.application_form_id
      WHERE aa.id = ?
        AND aa.applicant_user_id = ?
      LIMIT 1
    `,
    [applicationId, applicantUserId],
  );

  const application = applicationRows?.[0];

  if (!application) {
    throw new Error("The application was not found.");
  }

  if (
    clean(application.status).toUpperCase() !== "ADMITTED" &&
    clean(
      application.acceptance_payment_status,
    ).toUpperCase() !== "PAID"
  ) {
    throw new Error(
      "Acceptance-fee payment is available only after admission.",
    );
  }

  const paymentType = await getPaymentType(
    application.acceptance_payment_type_id,
  );

  if (!paymentType || Number(paymentType.is_active) !== 1) {
    throw new Error(
      "The acceptance payment type has not been configured.",
    );
  }

  const serviceTypeId =
    resolveAcceptanceServiceTypeId(
      paymentType,
    );

  if (!serviceTypeId) {
    throw new Error(
      "The selected acceptance payment type does not have a Remita STID.",
    );
  }

  if (application.acceptance_invoice_id) {
    const [invoiceRows] = await db.query(
      `
        SELECT *
        FROM payment_invoices
        WHERE id = ?
        LIMIT 1
      `,
      [application.acceptance_invoice_id],
    );

    const invoice = invoiceRows?.[0];

    if (invoice) {
      if (
        clean(invoice.status).toUpperCase() === "PAID"
      ) {
        await db.query(
          `
            UPDATE applicant_applications
            SET acceptance_payment_status = 'PAID'
            WHERE id = ?
          `,
          [application.id],
        );

        return {
          orderId: invoice.order_id,
          status: "PAID",
          slug: application.application_slug,
        };
      }

      const connection = await db.getConnection();

      try {
        await connection.beginTransaction();

        const { total } =
          await replaceAcceptanceLines({
            connection,
            applicantApplicationId:
              application.id,
            applicationFormId:
              application.application_form_id,
            invoiceId: invoice.id,
          });

        const amountChanged =
          money(invoice.amount) !== total;

        const paymentTypeChanged =
          Number(invoice.payment_type_id) !==
          Number(paymentType.id);

        const stidChanged =
          clean(invoice.remita_service_type_id) !==
          serviceTypeId;

        await connection.query(
          `
            UPDATE payment_invoices
            SET
              payment_type_id = ?,
              purpose = ?,
              amount = ?,
              portal_charge = 0,
              remita_service_type_id = ?,
              status = 'PENDING',
              rrr = CASE
                WHEN ? = 1 THEN NULL
                ELSE rrr
              END,
              payment_meta = CASE
                WHEN ? = 1 THEN NULL
                ELSE payment_meta
              END
            WHERE id = ?
          `,
          [
            paymentType.id,
            `${application.application_title} - Acceptance Charges`,
            total,
            serviceTypeId,
            amountChanged ||
            paymentTypeChanged ||
            stidChanged
              ? 1
              : 0,
            amountChanged ||
            paymentTypeChanged ||
            stidChanged
              ? 1
              : 0,
            invoice.id,
          ],
        );

        await connection.query(
          `
            UPDATE applicant_applications
            SET acceptance_payment_status = 'PENDING'
            WHERE id = ?
          `,
          [application.id],
        );

        await connection.commit();

        return {
          orderId: invoice.order_id,
          status: "PENDING",
          slug: application.application_slug,
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  }

  const [chargeRows] = await db.query(
    `
      SELECT
        id,
        charge_name,
        amount
      FROM application_form_charges
      WHERE application_form_id = ?
        AND charge_stage = 'ACCEPTANCE'
        AND is_active = 1
      ORDER BY display_order, id
    `,
    [application.application_form_id],
  );

  const total = chargeRows.reduce(
    (sum, charge) => sum + money(charge.amount),
    0,
  );

  if (total <= 0) {
    throw new Error(
      "No payable acceptance charge has been configured for this application.",
    );
  }

  const created = await createInvoice({
    payment_type_id: paymentType.id,
    payee_id:
      clean(applicant.username) ||
      String(applicant.id),
    payee_fullname:
      fullName(applicant) || "Applicant",
    payee_email: emailAddress(applicant),
    payee_phone: normalizePhone(applicant.phone),
    purpose:
      `${application.application_title} - Acceptance Charges`,
    amount: total,
    portal_charge_override: 0,
    method: "ONLINE",
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
      applicant.id,
      created.id,
    ],
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `
        UPDATE applicant_applications
        SET
          acceptance_invoice_id = ?,
          acceptance_payment_status = 'PENDING'
        WHERE id = ?
      `,
      [created.id, application.id],
    );

    await replaceAcceptanceLines({
      connection,
      applicantApplicationId: application.id,
      applicationFormId:
        application.application_form_id,
      invoiceId: created.id,
    });

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    orderId: created.order_id,
    status: "PENDING",
    slug: application.application_slug,
  };
}
