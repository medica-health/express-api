import { Resend } from "resend";
import { env } from "../config/env";
import { query } from "../db";
import { isPhonePlaceholder } from "../utils/phonePatient";

// Transactional email through Resend (https://resend.com).
// With RESEND_API_KEY unset (local dev, tests) emails are logged and recorded as SKIPPED.

let client: Resend | null = null;
function resend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  type: string; // e.g. APPOINTMENT_BOOKED; also sent to Resend as a tag
  userId?: string;
  appointmentId?: string;
  /** Resend de-duplicates sends with the same key for 24h (use for reminders/retries). */
  idempotencyKey?: string;
}

export interface DeliveryResult {
  status: "SENT" | "FAILED" | "SKIPPED";
  providerMessageId: string | null;
  error: string | null;
}

const RETRYABLE = new Set(["rate_limit_exceeded", "internal_server_error", "application_error"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends one email via Resend, retrying rate-limit/5xx errors with backoff. Never throws. */
export async function deliver(mail: Mail, maxAttempts = 3): Promise<DeliveryResult> {
  const r = resend();
  if (!r) {
    console.log(`[mail skipped: RESEND_API_KEY not set] to=${mail.to} subject="${mail.subject}"`);
    return { status: "SKIPPED", providerMessageId: null, error: null };
  }

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await r.emails.send(
        {
          from: env.MAIL_FROM,
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
          tags: [{ name: "type", value: mail.type.replace(/[^A-Za-z0-9_-]/g, "_") }],
        },
        mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : undefined,
      );
      if (data) return { status: "SENT", providerMessageId: data.id, error: null };
      lastError = `${error.name}: ${error.message}`;
      if (!RETRYABLE.has(error.name)) break;
    } catch (err) {
      lastError = (err as Error).message; // network failure
    }
    if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
  }
  console.error(`Email to ${mail.to} failed: ${lastError}`);
  return { status: "FAILED", providerMessageId: null, error: lastError };
}

export interface LogEntry {
  userId?: string;
  appointmentId?: string;
  type: string;
  channel: "EMAIL" | "SMS";
  recipient: string;
  subject: string;
  result: DeliveryResult;
}

/** Writes one row to app.notifications_log. Never throws. */
export async function insertNotificationLog(e: LogEntry): Promise<void> {
  await query(
    `INSERT INTO app.notifications_log
       (user_id, appointment_id, type, channel, recipient, subject, status, error, provider_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.userId ?? null,
      e.appointmentId ?? null,
      e.type,
      e.channel,
      e.recipient,
      e.subject,
      e.result.status,
      e.result.error,
      e.result.providerMessageId,
    ],
  ).catch((err: Error) => console.error("notifications_log insert failed:", err.message));
}

// Sends and records the outcome in app.notifications_log. Never throws:
// notification problems must not fail the request that triggered them.
// Phone-registered patients have a placeholder address that can't receive mail: record, don't send.
// `log` is injectable so tests don't need a database.
export async function sendMail(mail: Mail, log: (e: LogEntry) => Promise<void> = insertNotificationLog): Promise<void> {
  const result: DeliveryResult = isPhonePlaceholder(mail.to)
    ? { status: "SKIPPED", providerMessageId: null, error: "placeholder address" }
    : await deliver(mail);
  await log({
    userId: mail.userId,
    appointmentId: mail.appointmentId,
    type: mail.type,
    channel: "EMAIL",
    recipient: mail.to,
    subject: mail.subject,
    result,
  });
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
