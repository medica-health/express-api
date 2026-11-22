import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { query } from "../db";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  type: string; // e.g. APPOINTMENT_BOOKED
  userId?: string;
  appointmentId?: string;
}

// Sends an email and records the outcome in app.notifications_log. Never throws:
// notification problems must not fail the request that triggered them.
export async function sendMail(mail: Mail): Promise<void> {
  let status: "SENT" | "FAILED" | "SKIPPED" = "SENT";
  let error: string | null = null;

  const t = getTransporter();
  if (!t) {
    status = "SKIPPED";
    console.log(`[mail skipped: SMTP_HOST not set] to=${mail.to} subject="${mail.subject}"`);
  } else {
    try {
      await t.sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (err) {
      status = "FAILED";
      error = (err as Error).message;
      console.error(`Email to ${mail.to} failed:`, error);
    }
  }

  await query(
    `INSERT INTO app.notifications_log (user_id, appointment_id, type, recipient, subject, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [mail.userId ?? null, mail.appointmentId ?? null, mail.type, mail.to, mail.subject, status, error],
  ).catch((err: Error) => console.error("notifications_log insert failed:", err.message));
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Minimal branded HTML layout shared by all emails.
export function layout(title: string, paragraphs: string[], cta?: { label: string; path: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escape(p)}</p>`).join("");
  const button = cta
    ? `<p><a href="${env.APP_BASE_URL}${cta.path}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escape(cta.label)}</a></p>`
    : "";
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="color:#0f766e">${escape(title)}</h2>${body}${button}
<p style="color:#6b7280;font-size:12px;margin-top:24px">This is an automated message from MediCare.</p></div>`;
}
