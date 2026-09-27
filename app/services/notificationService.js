import nodemailer from "nodemailer";
import db from "../core/db.js";

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM_EMAIL);
}

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
  });
}

export async function createPortalNotification(connection, data) {
  const executor = connection || db;
  const [result] = await executor.query(
    `INSERT INTO portal_notifications
      (public_user_id, applicant_application_id, notification_type, title, message, action_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.publicUserId, data.applicationId || null, data.type, data.title,
     data.message, data.actionUrl || null],
  );
  if (data.email) {
    await executor.query(
      `INSERT INTO notification_deliveries
        (notification_id, recipient, status) VALUES (?, ?, 'PENDING')`,
      [result.insertId, data.email],
    );
  }
  return result.insertId;
}

export async function sendPendingEmail(deliveryId) {
  const [[row]] = await db.query(
    `SELECT nd.*, pn.title, pn.message, pn.action_url
       FROM notification_deliveries nd
       JOIN portal_notifications pn ON pn.id=nd.notification_id
      WHERE nd.id=? AND nd.status <> 'SENT' LIMIT 1`,
    [deliveryId],
  );
  if (!row) return { sent: false, reason: "Delivery not found or already sent." };
  if (!smtpConfigured()) return { sent: false, reason: "SMTP is not configured." };

  const baseUrl = String(process.env.PORTAL_BASE_URL || "").replace(/\/$/, "");
  const actionUrl = row.action_url
    ? `${baseUrl}${String(row.action_url).startsWith("/") ? "" : "/"}${row.action_url}`
    : baseUrl;
  try {
    await transporter().sendMail({
      from: { name: process.env.SMTP_FROM_NAME || "Admissions Office", address: process.env.SMTP_FROM_EMAIL },
      to: row.recipient,
      subject: row.title,
      text: `${row.message}\n\nOpen your portal: ${actionUrl}`,
      html: `<p>${String(row.message).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])).replace(/\n/g, "<br>")}</p><p><a href="${actionUrl}">Open your portal</a></p>`,
    });
    await db.query(
      `UPDATE notification_deliveries SET status='SENT', attempts=attempts+1,
       last_error=NULL, sent_at=NOW() WHERE id=?`, [deliveryId],
    );
    return { sent: true };
  } catch (error) {
    await db.query(
      `UPDATE notification_deliveries SET status='FAILED', attempts=attempts+1,
       last_error=? WHERE id=?`, [String(error.message || error).slice(0, 500), deliveryId],
    );
    return { sent: false, reason: "Email delivery failed." };
  }
}

export async function dispatchNotificationEmails(notificationId) {
  const [rows] = await db.query(
    `SELECT id FROM notification_deliveries WHERE notification_id=? AND status <> 'SENT'`,
    [notificationId],
  );
  return Promise.all(rows.map(row => sendPendingEmail(row.id)));
}
