interface TechContactEnv {
  CACHE?: {
    get(key: string, type?: "text"): Promise<unknown>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

const CONTACT_RECIPIENT = "shuletech15@gmail.com";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 600;
const SERVICES = new Set(["Website", "Android", "iOS", "Logo & Hosting", "Learn Coding", "Other"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clean(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\0/g, "").trim().slice(0, maxLength);
}

async function rateLimitKey(ipAddress: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ipAddress));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `tech-contact:${fingerprint}`;
}

async function isRateLimited(request: Request, env: TechContactEnv): Promise<boolean> {
  const ipAddress = request.headers.get("cf-connecting-ip");
  if (!env.CACHE || !ipAddress) return false;

  const key = await rateLimitKey(ipAddress);
  const stored = await env.CACHE.get(key, "text");
  const count = Number(stored ?? 0);
  if (Number.isFinite(count) && count >= RATE_LIMIT_MAX) return true;
  await env.CACHE.put(key, String((Number.isFinite(count) ? count : 0) + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return false;
}

export async function handleTechContactRoute(
  request: Request,
  env: TechContactEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/tech/contact") return null;
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ ok: false, error: "Send the inquiry as JSON" }, 415);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 12_000) {
    return json({ ok: false, error: "The message is too large" }, 413);
  }

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "Enter the inquiry details and try again" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "The inquiry could not be read" }, 400);
  }

  // Quietly accept automated submissions without forwarding them.
  if (clean(input.website, 200)) return json({ ok: true, accepted: true }, 202);

  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    return json({ ok: false, error: "The contact form is temporarily unavailable. Please use WhatsApp or email." }, 503);
  }

  let limited: boolean;
  try {
    limited = await isRateLimited(request, env);
  } catch {
    return json({ ok: false, error: "The contact form is temporarily unavailable. Please try again shortly." }, 503);
  }
  if (limited) return json({ ok: false, error: "Please wait a few minutes before sending another inquiry." }, 429);

  const name = clean(input.name, 120);
  const phone = clean(input.phone, 64);
  const email = clean(input.email, 254).toLowerCase();
  const service = clean(input.service, 80);
  const message = clean(input.message, 4000);
  if (!name || !phone || !email || !SERVICES.has(service) || message.length < 10) {
    return json({ ok: false, error: "Complete each field and include a message of at least 10 characters." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\r\n]/.test(email)) {
    return json({ ok: false, error: "Enter a valid email address." }, 400);
  }

  let deliveryResponse: Response;
  try {
    deliveryResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [CONTACT_RECIPIENT],
        reply_to: email,
        subject: "New Shule-Tech website inquiry",
        text: [
          `Name: ${name}`,
          `Phone: ${phone}`,
          `Email: ${email}`,
          `Service: ${service}`,
          "",
          "Message:",
          message,
        ].join("\n"),
      }),
    });
  } catch {
    return json({ ok: false, error: "We could not send the inquiry. Please try WhatsApp or email instead." }, 502);
  }

  if (!deliveryResponse.ok) {
    return json({ ok: false, error: "We could not send the inquiry. Please try WhatsApp or email instead." }, 502);
  }
  return json({ ok: true, message: "Your inquiry has been sent." }, 202);
}