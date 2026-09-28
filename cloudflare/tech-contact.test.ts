import assert from "node:assert/strict";
import test from "node:test";
import { handleTechContactRoute } from "./tech-contact";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://appshule.com/api/tech/contact", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validInquiry = {
  name: "Test User",
  phone: "+256700000000",
  email: "test@example.com",
  service: "Website",
  message: "I would like to discuss a new business website.",
  website: "",
};

const environment = {
  RESEND_API_KEY: "test-resend-key",
  RESEND_FROM_EMAIL: "noreply@appshule.com",
};

test("rejects invalid contact details without calling the mail provider", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await handleTechContactRoute(
      request({ ...validInquiry, email: "not-an-email" }),
      environment,
    );
    assert.equal(response?.status, 400);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a valid inquiry and sends it through the configured mail provider", async () => {
  const originalFetch = globalThis.fetch;
  let sentRequest: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    sentRequest = { url: String(input), init };
    return new Response(JSON.stringify({ id: "email_test_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await handleTechContactRoute(
      request(validInquiry, { "cf-connecting-ip": "192.0.2.5" }),
      environment,
    );
    assert.equal(response?.status, 202);
    assert.equal(sentRequest?.url, "https://api.resend.com/emails");
    const payload = JSON.parse(String(sentRequest?.init?.body)) as Record<string, unknown>;
    assert.equal(payload.reply_to, validInquiry.email);
    assert.equal(payload.to instanceof Array && payload.to[0], "shuletech15@gmail.com");
    assert.match(String(payload.text), /new business website/);
    assert.deepEqual(await response?.json(), { ok: true, message: "Your inquiry has been sent." });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("silently drops honeypot submissions without sending email", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await handleTechContactRoute(
      request({ ...validInquiry, website: "automated spam" }),
      environment,
    );
    assert.equal(response?.status, 202);
    assert.equal(fetchCalled, false);
    assert.deepEqual(await response?.json(), { ok: true, accepted: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not report success when the mail provider fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 503 });
  try {
    const response = await handleTechContactRoute(request(validInquiry), environment);
    assert.equal(response?.status, 502);
    assert.equal((await response?.json() as { ok: boolean }).ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matches only the Tech contact endpoint and requires POST", async () => {
  assert.equal(await handleTechContactRoute(
    new Request("https://appshule.com/api/tech/other"),
    environment,
  ), null);

  const response = await handleTechContactRoute(
    new Request("https://appshule.com/api/tech/contact"),
    environment,
  );
  assert.equal(response?.status, 405);
});