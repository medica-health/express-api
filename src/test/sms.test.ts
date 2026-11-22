import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { deliverSms, maskPhone, smsConfigWarning, type Sms } from "../services/sms.service";

const realFetch = globalThis.fetch;
beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {}); // expected "skipped"/"failed" lines
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

const sms: Sms = { to: "+919876543210", body: "MediCare: hello", type: "APPOINTMENT_BOOKED" };

describe("deliverSms (Twilio)", () => {
  test("posts form to Twilio Messages API with basic auth", async () => {
    const calls = stubFetch({ status: 201, body: { sid: "SM123" } });
    const result = await deliverSms(sms);

    expect(result).toEqual({ status: "SENT", providerMessageId: "SM123", error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("AC_test:test")}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("To")).toBe("+919876543210");
    expect(form.get("Body")).toBe("MediCare: hello");
    expect(form.get("From")).toBe("+15005550006");
    expect(form.has("MessagingServiceSid")).toBe(false);
  });

  test("retries 429 then succeeds", async () => {
    const calls = stubFetch({ status: 429, body: { code: 20429, message: "Too many requests" } }, { status: 201, body: { sid: "SM456" } });
    const result = await deliverSms(sms);
    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toBe("SM456");
    expect(calls).toHaveLength(2);
  });

  test("does not retry 400", async () => {
    const calls = stubFetch({ status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number" } });
    const result = await deliverSms(sms);
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("21211");
    expect(calls).toHaveLength(1);
  });

  test("skips when credentials missing", async () => {
    const { env } = await import("../config/env");
    const saved = { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
    env.TWILIO_ACCOUNT_SID = "";
    env.TWILIO_AUTH_TOKEN = "";
    try {
      const calls = stubFetch({ status: 201, body: { sid: "SM1" } });
      const result = await deliverSms(sms);
      expect(result.status).toBe("SKIPPED");
      expect(calls).toHaveLength(0);
    } finally {
      env.TWILIO_ACCOUNT_SID = saved.sid;
      env.TWILIO_AUTH_TOKEN = saved.token;
    }
  });
});

describe("phone masking in logs", () => {
  test("keeps +91 and the last 4 digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91******3210");
    expect(maskPhone("+15005550006")).toBe("+*******0006");
    expect(maskPhone("")).toBe("");
  });

  test("a failed SMS logs the masked number only", async () => {
    stubFetch({ status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number" } });
    const err = spyOn(console, "error").mockImplementation(() => {});
    await deliverSms(sms);
    const logged = err.mock.calls.map((c) => c.join(" ")).join(" | ");
    expect(logged).toContain("+91******3210");
    expect(logged).not.toContain("9876543210");
  });

  test("a skipped SMS logs the masked number only", async () => {
    const { env } = await import("../config/env");
    const saved = { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
    env.TWILIO_ACCOUNT_SID = "";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await deliverSms(sms);
      const logged = log.mock.calls.map((c) => c.join(" ")).join(" | ");
      expect(logged).toContain("+91******3210");
      expect(logged).not.toContain("9876543210");
    } finally {
      env.TWILIO_ACCOUNT_SID = saved.sid;
      env.TWILIO_AUTH_TOKEN = saved.token;
    }
  });
});

describe("smsConfigWarning", () => {
  const base = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "", TWILIO_MESSAGING_SERVICE_SID: "" };

  test("warns when credentials are set without a sender", () => {
    expect(smsConfigWarning(base)).toContain("TWILIO_SMS_FROM");
  });

  test("quiet when a sender is set or Twilio is off", () => {
    expect(smsConfigWarning({ ...base, TWILIO_SMS_FROM: "+15005550006" })).toBeNull();
    expect(smsConfigWarning({ ...base, TWILIO_MESSAGING_SERVICE_SID: "MG1" })).toBeNull();
    expect(smsConfigWarning({ ...base, TWILIO_ACCOUNT_SID: "" })).toBeNull();
  });
});
