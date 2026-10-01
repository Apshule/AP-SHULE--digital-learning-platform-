import { describe, expect, it } from "vitest";
import {
  allocateMfiRepaymentV10,
  handlePaymentMfiV10Route,
  normalizeMfiInstallmentV10,
} from "./payment-mfi-v10";
import type { AuthEnv, AuthUser } from "./backend-types";

const user: AuthUser = {
  uid: "staff-1", email: "staff@example.test", displayName: "Staff", role: "mfi_admin",
  schoolId: null, institutionId: "tenant-1", sessionVersion: 1,
};
const toBase64 = (data: ArrayBuffer | Uint8Array) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
};

function mockNeon(options: { capability?: string; paymentAmount?: number } = {}) {
  const state = { settled: 0, events: [] as Row[], queries: [] as string[] };
  const pg = {
    async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []) {
      state.queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] as T[] };
      if (sql.includes("role_capabilities")) return {
        rows: (options.capability ? [{ capability: options.capability }] : []) as T[],
      };
      if (sql.includes("SELECT event_key,payment_id,result_json FROM yo_ipn_events")) {
        return { rows: state.events.filter((row) => row.event_key === values[0]) as T[] };
      }
      if (sql.includes("FROM payments WHERE provider_reference")) {
        return {
          rows: [{
            id: "payment-1", amount: options.paymentAmount ?? 2500,
            status: "pending", provider: "yo", provider_reference: "PAY-1",
            institution_id: "tenant-1", payer_id: "payer-1",
          }] as T[],
        };
      }
      if (sql.includes("UPDATE payments SET status='completed'")) {
        state.settled += 1;
        return { rows: [{ id: "payment-1" }] as T[] };
      }
      if (sql.includes("INSERT INTO yo_ipn_events")) {
        const eventKey = String(values[0]);
        state.events.push({
          event_key: eventKey,
          provider_reference: values[1],
          network_reference: values[2],
          payment_id: values[3] ?? null,
          status: "settled",
          result_json: values[4],
        });
        return { rows: [] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  const unusedR2 = {
    async get() { throw new Error("R2 must not be used for payment or MFI persistence"); },
    async put() { throw new Error("R2 must not be used for payment or MFI persistence"); },
    async delete() { throw new Error("R2 must not be used for payment or MFI persistence"); },
  };
  return { env: { PG: pg, R2: unusedR2 } as unknown as AuthEnv, state };
}

type Row = Record<string, unknown>;

async function signedRequest(amount: string, body = `{"external_ref":"PAY-1","amount":"${amount}","network_ref":"N-1"}`) {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body));
  const publicDer = await crypto.subtle.exportKey("spki", keys.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${toBase64(publicDer).match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----`;
  const request = new Request("https://example.test/api/payments/ipn", {
    method: "POST", headers: { "content-type": "application/json", "x-yo-signature": toBase64(signature) }, body,
  });
  return { request, env: { ...mockNeon().env, YO_API_PUBLIC_KEY: pem } as AuthEnv, publicEnvKey: pem };
}

describe("standalone payment and MFI v10 routes", () => {
  it("verifies RSA-SHA1 over the exact body and settles using the stored pending amount", async () => {
    const body = '{ "external_ref" : "PAY-1", "amount" : "2500.00", "network_ref" : "N-1" }';
    const signed = await signedRequest("2500.00", body);
    const { env, state } = mockNeon({ paymentAmount: 2500 });
    Object.assign(env, { YO_API_PUBLIC_KEY: signed.publicEnvKey });
    const replay = signed.request.clone();
    const response = await handlePaymentMfiV10Route(signed.request, env, null);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, processed: true });
    const duplicate = await handlePaymentMfiV10Route(replay, env, null);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ ok: true, processed: true });
    expect(state.settled).toBe(1);
    expect(state.queries.some((sql) => sql.includes("UPDATE payments SET status='completed'"))).toBe(true);
  });

  it("rejects a signed callback amount that differs from the pending Neon amount", async () => {
    const signed = await signedRequest("2.50");
    const { env, state } = mockNeon({ paymentAmount: 2500 });
    Object.assign(env, { YO_API_PUBLIC_KEY: signed.publicEnvKey });
    const response = await handlePaymentMfiV10Route(signed.request, env, null);
    expect(response?.status).toBe(400);
    expect(state.settled).toBe(0);
    expect(state.queries.some((sql) => sql.includes("UPDATE payments SET status='completed'"))).toBe(false);
  });

  it("rejects a body changed after its exact bytes were signed", async () => {
    const signed = await signedRequest("2500.00");
    const tampered = new Request(signed.request.url, {
      method: "POST",
      headers: signed.request.headers,
      body: '{"external_ref":"PAY-1","amount":"2500.00","network_ref":"N-2"}',
    });
    const { env, state } = mockNeon();
    Object.assign(env, { YO_API_PUBLIC_KEY: signed.publicEnvKey });
    const response = await handlePaymentMfiV10Route(tampered, env, null);
    expect(response?.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });

  it("blocks MFI writes without an authenticated principal or capability", async () => {
    const request = new Request("https://example.test/api/mfi/loans/loan-1/repayment", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 10, idempotencyKey: "key-1" }),
    });
    const unauthenticated = await handlePaymentMfiV10Route(request, mockNeon().env, null);
    expect(unauthenticated?.status).toBe(401);
    const unauthorized = await handlePaymentMfiV10Route(request, mockNeon().env, user);
    expect(unauthorized?.status).toBe(403);
  });

  it("normalizes legacy aggregate paidAmount/paidPrincipal before allocating another repayment", () => {
    const normalized = normalizeMfiInstallmentV10({
      id: "installment-1", principalDue: 100, interestDue: 20, paidAmount: 60, paidPrincipal: 50,
    });
    expect(normalized).toMatchObject({ principalPaid: 50, interestPaid: 10, principalBalance: 50, interestBalance: 10 });
    const allocation = allocateMfiRepaymentV10(20, [{
      id: "installment-1", installmentNumber: 1, principalDue: 100, interestDue: 20,
      paidAmount: 60, paidPrincipal: 50,
    }]);
    expect(allocation.applications[0]).toMatchObject({ amountToInterest: 10, amountToPrincipal: 10 });
    expect(allocation.updated[0]).toMatchObject({ paidPrincipal: 60, principalBalance: 40, interestBalance: 0 });
  });

  it("returns null for routes owned by other dispatchers", async () => {
    const response = await handlePaymentMfiV10Route(
      new Request("https://example.test/api/mfi/loans/loan-1/schedule"), mockNeon().env, user,
    );
    expect(response?.status).toBe(405);
    const unrelated = await handlePaymentMfiV10Route(
      new Request("https://example.test/api/health"), mockNeon().env, user,
    );
    expect(unrelated).toBeNull();
  });
});