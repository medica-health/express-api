import { env } from "../config/env";
import { insertNotificationLog, type DeliveryResult, type LogEntry } from "./mailer.service";

// SMS through Twilio's REST API (called with fetch, no SDK) for phone-registered patients.
// With TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset (local dev, tests) SMS is logged and recorded as SKIPPED.

export interface Sms {
  to: string; // E.164
  body: string;
  type: string; // e.g. APPOINTMENT_BOOKED
  /** Event subject, stored in notifications_log.subject. */
  subject?: string;
  userId?: string;
  appointmentId?: string;
}

/** Masks a phone number for logs: keeps the +91 (else +) prefix and the last 4 digits. */
export function maskPhone(phone: string): string {
  if (!phone) return phone;
  const prefix = phone.startsWith("+91") ? "+91" : phone.startsWith("+") ? "+" : "";
  const rest = phone.slice(prefix.length);
  return `${prefix}${"*".repeat(Math.max(rest.length - 4, 0))}${rest.slice(-4)}`;
}

/**
 * Startup check: Twilio credentials without a sender make every SMS fail. Returns the
 * warning to log once at startup, or null when the config is consistent.
 */
export function smsConfigWarning(e: Pick<typeof env, "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_SMS_FROM" | "TWILIO_MESSAGING_SERVICE_SID"> = env): string | null {
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN) return null;
  if (e.TWILIO_SMS_FROM || e.TWILIO_MESSAGING_SERVICE_SID) return null;
  return "Twilio credentials are set but neither TWILIO_SMS_FROM nor TWILIO_MESSAGING_SERVICE_SID is: every SMS will fail.";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

/** Sends one SMS via Twilio, retrying 429/5xx with backoff. Never throws. */
export async function deliverSms(sms: Sms, maxAttempts = 3): Promise<DeliveryResult> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.log(`[sms skipped: Twilio credentials not set] to=${maskPhone(sms.to)}`);
    return { status: "SKIPPED", providerMessageId: null, error: null };
  }

  const form = new URLSearchParams({ To: sms.to, Body: sms.body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", env.TWILIO_SMS_FROM);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
  const auth = `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
      if (res.ok && json.sid) return { status: "SENT", providerMessageId: json.sid, error: null };
      lastError = `Twilio ${res.status}${json.code ? ` ${json.code}` : ""}: ${json.message ?? "request failed"}`;
      if (!retryable(res.status)) break;
    } catch (err) {
      lastError = (err as Error).message; // network failure
    }
    if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
  }
  console.error(`SMS to ${maskPhone(sms.to)} failed: ${lastError}`);
  return { status: "FAILED", providerMessageId: null, error: lastError };
}

// Sends and records the outcome in app.notifications_log (channel SMS). Never throws.
// Returns the delivery result so callers can tell SENT from FAILED/SKIPPED.
// `log` is injectable so tests don't need a database.
export async function sendSms(sms: Sms, log: (e: LogEntry) => Promise<void> = insertNotificationLog): Promise<DeliveryResult> {
  const result: DeliveryResult = sms.to
    ? await deliverSms(sms)
    : { status: "SKIPPED", providerMessageId: null, error: "no phone" };
  await log({
    userId: sms.userId,
    appointmentId: sms.appointmentId,
    type: sms.type,
    channel: "SMS",
    recipient: sms.to,
    subject: sms.subject ?? sms.type,
    result,
  });
  return result;
}
