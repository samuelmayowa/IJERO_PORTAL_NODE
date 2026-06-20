import db from "../core/db.js";

function clean(value) {
  return String(value ?? "").trim();
}

export async function syncApplicationPaymentByOrderId(
  orderId,
) {
  const safeOrderId = clean(orderId);

  if (!safeOrderId) return null;

  const [invoiceRows] = await db.query(
    `
      SELECT
        id,
        order_id,
        status
      FROM payment_invoices
      WHERE order_id = ?
      LIMIT 1
    `,
    [safeOrderId],
  );

  const invoice = invoiceRows?.[0];

  if (!invoice) return null;

  const [applicationRows] = await db.query(
    `
      SELECT
        aa.id,
        aa.application_form_id,
        aa.applicant_user_id,
        aa.status,
        aa.application_payment_status,
        aa.acceptance_payment_status,
        CASE
          WHEN aa.acceptance_invoice_id = ?
            THEN 'ACCEPTANCE'
          ELSE 'APPLICATION'
        END AS payment_stage
      FROM applicant_applications aa
      WHERE aa.application_invoice_id = ?
         OR aa.acceptance_invoice_id = ?
      ORDER BY aa.id DESC
      LIMIT 1
    `,
    [
      invoice.id,
      invoice.id,
      invoice.id,
    ],
  );

  const application = applicationRows?.[0];

  if (!application) return null;

  const invoiceStatus = clean(
    invoice.status,
  ).toUpperCase();

  const stage = clean(
    application.payment_stage,
  ).toUpperCase();

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    if (stage === "ACCEPTANCE") {
      if (invoiceStatus === "PAID") {
        await connection.query(
          `
            UPDATE applicant_applications
            SET acceptance_payment_status = 'PAID'
            WHERE id = ?
          `,
          [application.id],
        );

        await connection.query(
          `
            UPDATE application_payment_lines
            SET payment_status = CASE
              WHEN amount <= 0 THEN 'NO_CHARGE'
              ELSE 'PAID'
            END
            WHERE applicant_application_id = ?
              AND charge_stage = 'ACCEPTANCE'
          `,
          [application.id],
        );
      } else if (
        ["FAILED", "CANCELLED"].includes(
          invoiceStatus,
        )
      ) {
        await connection.query(
          `
            UPDATE applicant_applications
            SET acceptance_payment_status = 'FAILED'
            WHERE id = ?
          `,
          [application.id],
        );

        await connection.query(
          `
            UPDATE application_payment_lines
            SET payment_status = CASE
              WHEN amount <= 0 THEN 'NO_CHARGE'
              ELSE 'FAILED'
            END
            WHERE applicant_application_id = ?
              AND charge_stage = 'ACCEPTANCE'
          `,
          [application.id],
        );
      } else {
        await connection.query(
          `
            UPDATE applicant_applications
            SET acceptance_payment_status = 'PENDING'
            WHERE id = ?
          `,
          [application.id],
        );
      }
    } else if (invoiceStatus === "PAID") {
      await connection.query(
        `
          UPDATE applicant_applications
          SET
            application_payment_status = 'PAID',
            status = CASE
              WHEN status IN (
                'DRAFT',
                'AWAITING_PAYMENT'
              )
              THEN 'IN_PROGRESS'
              ELSE status
            END
          WHERE id = ?
        `,
        [application.id],
      );

      await connection.query(
        `
          UPDATE application_payment_lines
          SET payment_status = CASE
            WHEN amount <= 0 THEN 'NO_CHARGE'
            ELSE 'PAID'
          END
          WHERE applicant_application_id = ?
            AND charge_stage = 'APPLICATION'
        `,
        [application.id],
      );

      await connection.query(
        `
          UPDATE application_prerequisites
          SET match_status = 'USED'
          WHERE application_form_id = ?
            AND matched_applicant_user_id = ?
            AND match_status IN ('MATCHED', 'USED')
        `,
        [
          application.application_form_id,
          application.applicant_user_id,
        ],
      );
    } else if (
      ["FAILED", "CANCELLED"].includes(invoiceStatus)
    ) {
      await connection.query(
        `
          UPDATE applicant_applications
          SET application_payment_status = 'FAILED'
          WHERE id = ?
        `,
        [application.id],
      );

      await connection.query(
        `
          UPDATE application_payment_lines
          SET payment_status = CASE
            WHEN amount <= 0 THEN 'NO_CHARGE'
            ELSE 'FAILED'
          END
          WHERE applicant_application_id = ?
            AND charge_stage = 'APPLICATION'
        `,
        [application.id],
      );
    } else {
      await connection.query(
        `
          UPDATE applicant_applications
          SET
            application_payment_status = 'PENDING',
            status = CASE
              WHEN status = 'DRAFT'
              THEN 'AWAITING_PAYMENT'
              ELSE status
            END
          WHERE id = ?
        `,
        [application.id],
      );
    }

    await connection.commit();

    return {
      application_id: application.id,
      invoice_id: invoice.id,
      invoice_status: invoiceStatus,
      payment_stage: stage,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
