import { afterEach, describe, expect, mock, test } from "bun:test";
import { deliver, type Mail } from "../services/mailer.service";

// Stubs global fetch (used by the Resend SDK) so no request leaves the machine.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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

const mail: Mail = {
  to: "patient@example.com",
  subject: "Reminder",
  html: "<p>hi</p>",
  text: "hi",
  type: "APPOINTMENT_REMINDER",
  idempotencyKey: "reminder/abc/123",
};

describe("deliver (Resend)", () => {
  test("sends the expected request and returns the Resend id", async () => {
    const calls = stubFetch({ status: 200, body: { id: "email_123" } });
    const result = await deliver(mail);

    expect(result).toEqual({ status: "SENT", providerMessageId: "email_123", error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_dummy_key");
    expect(headers.get("idempotency-key")).toBe("reminder/abc/123");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.to).toEqual(["patient@example.com"]);
    expect(body.subject).toBe("Reminder");
    expect(body.tags).toEqual([{ name: "type", value: "APPOINTMENT_REMINDER" }]);
  });

  test("retries rate limits, then succeeds", async () => {
    const calls = stubFetch(
      { status: 429, body: { name: "rate_limit_exceeded", message: "Too many requests", statusCode: 429 } },
      { status: 200, body: { id: "email_456" } },
    );
    const result = await deliver(mail);
    expect(result.status).toBe("SENT");
    expect(calls).toHaveLength(2);
  });

  test("does not retry permanent errors and reports FAILED", async () => {
    const calls = stubFetch({
      status: 403,
      body: { name: "invalid_from_address", message: "Domain not verified", statusCode: 403 },
    });
    const result = await deliver(mail);
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("invalid_from_address");
    expect(calls).toHaveLength(1);
  });
});
