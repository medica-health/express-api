import { afterEach, describe, expect, mock, test } from "bun:test";
import { notify } from "../services/notifications.service";
import { sendMail, type LogEntry } from "../services/mailer.service";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  const urls: string[] = [];
  const bodies: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(String(init?.body ?? ""));
    const body = String(url).includes("twilio") ? { sid: "SM1" } : { id: "email_1" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { urls, bodies };
}

const row = (patient_email: string, patient_phone: string | null) => ({
  id: "appt-1",
  start_at: new Date("2026-12-01T09:30:00Z"),
  timezone: "Asia/Kolkata",
  clinic_name: "City Clinic",
  clinic_address: "1 Main St, Pune",
  patient_id: "p1",
  patient_name: "Asha",
  patient_email,
  patient_phone,
  doctor_id: "d1",
  doctor_name: "Rao",
  doctor_email: "doc@example.com",
  cancel_reason: null,
});

function run(patient_email: string, patient_phone: string | null, event: "BOOKED" | "REMINDER" = "BOOKED", patientOnly = false) {
  const logs: LogEntry[] = [];
  const net = stubFetch();
  const done = notify("appt-1", event, {
    patientOnly,
    deps: { load: async () => row(patient_email, patient_phone), log: async (e) => void logs.push(e) },
  });
  return { logs, net, done };
}

describe("notify channel selection", () => {
  test("placeholder patient gets SMS, not email; doctor still emailed", async () => {
    const { logs, net, done } = run("p-abc@phone.medicare.invalid", "+919876543210");
    await done;
    expect(net.urls.filter((u) => u.includes("api.twilio.com"))).toHaveLength(1);
    expect(net.urls.filter((u) => u.includes("api.resend.com"))).toHaveLength(1);
    const sms = new URLSearchParams(net.bodies.find((_, i) => net.urls[i]!.includes("twilio"))!);
    expect(sms.get("To")).toBe("+919876543210");
    expect(sms.get("Body")).toStartWith("MediCare: Appointment with Dr. Rao on ");
    expect(sms.get("Body")).toEndWith("at City Clinic is booked.");
    expect(logs.find((l) => l.channel === "SMS")).toMatchObject({
      recipient: "+919876543210",
      subject: "Appointment confirmed",
      type: "APPOINTMENT_BOOKED",
      userId: "p1",
    });
    expect(logs.find((l) => l.recipient === "doc@example.com")?.channel).toBe("EMAIL");
  });

  test("patientOnly skips the doctor email", async () => {
    const { net, done } = run("p-abc@phone.medicare.invalid", "+919876543210", "BOOKED", true);
    await done;
    expect(net.urls.some((u) => u.includes("api.resend.com"))).toBe(false);
    expect(net.urls.some((u) => u.includes("api.twilio.com"))).toBe(true);
  });

  test("real email patient gets email, no SMS", async () => {
    const { logs, net, done } = run("asha@example.com", "+919876543210");
    await done;
    expect(net.urls.some((u) => u.includes("api.twilio.com"))).toBe(false);
    expect(net.urls.filter((u) => u.includes("api.resend.com"))).toHaveLength(2);
    expect(logs.every((l) => l.channel === "EMAIL")).toBe(true);
  });

  test("placeholder patient without phone: SMS SKIPPED 'no phone', nothing sent", async () => {
    const { logs, net, done } = run("p-abc@phone.medicare.invalid", null, "REMINDER");
    await done;
    expect(net.urls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ channel: "SMS", type: "APPOINTMENT_REMINDER" });
    expect(logs[0]!.result).toMatchObject({ status: "SKIPPED", error: "no phone" });
  });
});

describe("sendMail placeholder guard", () => {
  test("is SKIPPED and never calls Resend", async () => {
    const net = stubFetch();
    const logs: LogEntry[] = [];
    await sendMail(
      { to: "p-abc@phone.medicare.invalid", subject: "s", html: "h", text: "t", type: "X" },
      async (e) => void logs.push(e),
    );
    expect(net.urls).toHaveLength(0);
    expect(logs[0]!.result).toEqual({ status: "SKIPPED", providerMessageId: null, error: "placeholder address" });
    expect(logs[0]!.channel).toBe("EMAIL");
  });
});
