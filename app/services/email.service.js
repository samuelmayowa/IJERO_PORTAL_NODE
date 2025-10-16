
import nodemailer from 'nodemailer';

export async function sendMail({ to, subject, text, html, attachments=[] }){
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  const info = await transporter.sendMail({ from: process.env.SMTP_USER, to, subject, text, html, attachments });
  return info;
}
