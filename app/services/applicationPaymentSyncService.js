import db from "../core/db.js";
import { refreshApplicationFeeStatuses } from './admissionFeeObligationService.js';

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

  const [[variation]]=await db.query(`SELECT applicant_application_id,fee_stage FROM application_fee_variation_invoices WHERE invoice_id=? LIMIT 1`,[invoice.id]);
  const [applicationRows] = await db.query(
    `
      SELECT
        aa.id,
        aa.application_form_id,
        aa.applicant_user_id,
        aa.status,
        aa.application_payment_status,
        aa.acceptance_payment_status,
        aa.compulsory_payment_status,
        CASE
          WHEN aa.compulsory_invoice_id = ? THEN 'COMPULSORY'
          WHEN aa.acceptance_invoice_id = ?
            THEN 'ACCEPTANCE'
          ELSE 'APPLICATION'
        END AS payment_stage
      FROM applicant_applications aa
      WHERE (aa.application_invoice_id = ?
         OR aa.acceptance_invoice_id = ?
         OR aa.compulsory_invoice_id = ?)
         OR aa.id = ?
      ORDER BY aa.id DESC
      LIMIT 1
    `,
    [
      invoice.id,
      invoice.id,
      invoice.id,
      invoice.id,
      invoice.id,
      variation?.applicant_application_id||0,
    ],
  );

  const application = applicationRows?.[0];

  if (!application) return null;

  const invoiceStatus = clean(
    invoice.status,
  ).toUpperCase();

  const stage = clean(variation?.fee_stage||application.payment_stage).toUpperCase();

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    if(variation){await connection.query(`UPDATE application_fee_variation_invoices SET status=? WHERE invoice_id=?`,[invoiceStatus==='PAID'?'PAID':['FAILED','CANCELLED'].includes(invoiceStatus)?invoiceStatus:'PENDING',invoice.id]);await refreshApplicationFeeStatuses(application.id,connection);await connection.commit();return {application_id:application.id,invoice_id:invoice.id,invoice_status:invoiceStatus,payment_stage:stage,variation:true};}

    if(stage==='COMPULSORY'){
      const paymentStatus=invoiceStatus==='PAID'?'PAID':['FAILED','CANCELLED'].includes(invoiceStatus)?'FAILED':'PENDING';
      await connection.query(`UPDATE applicant_applications SET compulsory_payment_status=? WHERE id=?`,[paymentStatus,application.id]);
      if(paymentStatus!=='PENDING')await connection.query(`UPDATE application_payment_lines SET payment_status=CASE WHEN amount<=0 THEN 'NO_CHARGE' ELSE ? END WHERE applicant_application_id=? AND charge_stage='COMPULSORY'`,[paymentStatus,application.id]);
    } else if (stage === "ACCEPTANCE") {
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
