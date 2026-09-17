import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { verifyFirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();
const project = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const firestoreBase =
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const MOCK_PREMIUM_AMOUNT_UGX = Math.max(
  1,
  Number(process.env["YO_PREMIUM_AMOUNT_UGX"] ?? 10_000),
);

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

function now(): string {
  return new Date().toISOString();
}

function firestoreValue(value: unknown): FirestoreValue {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) {
    return { integerValue: String(value) };
  }
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: String(value ?? "") };
}

function firestoreFields(data: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, firestoreValue(value)]),
    ),
  };
}

function fieldValue(value: FirestoreValue | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  return undefined;
}

function documentData(document?: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document?.fields ?? {}).map(([key, value]) => [
      key,
      fieldValue(value),
    ]),
  );
}

async function firestoreRequest(
  path: string,
  init: RequestInit,
  callerToken?: string,
) {
  const adminToken = await getFirebaseAdminToken();
  const token = adminToken ?? callerToken;
  if (!token) throw new Error("Firebase service-account secret is not configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${firestoreBase}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`Firestore request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

async function findInvoiceByReference(reference: string): Promise<{
  path: string;
  data: Record<string, unknown>;
} | null> {
  const rows = (await firestoreRequest(
    ":runQuery",
    {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "invoices" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "yopayReference" },
              op: "EQUAL",
              value: firestoreValue(reference),
            },
          },
        },
      }),
    },
  )) as Array<{ document?: FirestoreDocument }>;
  const document = rows.find((row) => row.document?.name)?.document;
  if (!document?.name) return null;
  return {
    path: document.name.split("/documents/")[1] ?? "",
    data: documentData(document),
  };
}

function normalizedPhone(value: unknown): string {
  const raw = String(value ?? "").replace(/[\s()-]/g, "");
  if (/^07\d{8}$/.test(raw)) return `+256${raw.slice(1)}`;
  if (/^2567\d{8}$/.test(raw)) return `+${raw}`;
  if (/^\+2567\d{8}$/.test(raw)) return raw;
  return "";
}

function mockModeEnabled(): boolean {
  const mode = String(process.env["YO_PAYMENT_MODE"] ?? "mock").toLowerCase();
  return mode !== "production" && mode !== "live";
}

router.post("/payment/initiate-yopay", async (req: Request, res: Response) => {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
    return;
  }

  const phoneNumber = normalizedPhone(req.body?.phoneNumber ?? req.body?.phone);
  if (!phoneNumber) {
    res.status(400).json({
      ok: false,
      error: "A valid Uganda mobile phone number is required",
    });
    return;
  }
  if (!mockModeEnabled()) {
    res.status(503).json({
      ok: false,
      error: "Mock Yo! Payments are disabled while live payment mode is enabled",
    });
    return;
  }

  const invoiceId = `INV-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const yopayReference = `YO-MOCK-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
  const invoice = {
    userId: caller.uid,
    amount: MOCK_PREMIUM_AMOUNT_UGX,
    currency: "UGX",
    status: "pending",
    yopayReference,
    createdAt: now(),
  };

  try {
    await firestoreRequest(
      `/invoices/${encodeURIComponent(invoiceId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(firestoreFields(invoice)),
      },
      caller.token,
    );
    res.status(201).json({
      ok: true,
      mock: true,
      invoiceId,
      ...invoice,
      message: "Mock Yo! Mobile Money push initiated.",
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to create invoice",
    });
  }
});

router.post("/payment/webhook/yopay", async (req: Request, res: Response) => {
  if (!mockModeEnabled()) {
    res.status(403).json({ ok: false, error: "Mock Yo! webhook is disabled" });
    return;
  }

  const reference = String(req.body?.reference ?? req.body?.yopayReference ?? "").trim();
  const status = String(req.body?.status ?? "").trim().toUpperCase();
  if (!reference || !["SUCCESS", "FAILED", "PENDING"].includes(status)) {
    res.status(400).json({
      ok: false,
      error: "reference and status (SUCCESS, FAILED, or PENDING) are required",
    });
    return;
  }

  try {
    const match = await findInvoiceByReference(reference);
    if (!match) {
      res.status(404).json({ ok: false, error: "Invoice not found" });
      return;
    }

    const currentStatus = String(match.data.status ?? "pending");
    if (currentStatus === "paid") {
      res.status(200).json({
        ok: true,
        duplicate: true,
        status: "paid",
        reference,
      });
      return;
    }

    const nextStatus = status === "SUCCESS" ? "paid" : status.toLowerCase();
    await firestoreRequest(`/${match.path}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ status: nextStatus })),
    });

    if (nextStatus === "paid") {
      const adminToken = await getFirebaseAdminToken();
      if (!adminToken) {
        res.status(503).json({
          ok: false,
          error: "Firebase service-account secret is required to activate premium access",
        });
        return;
      }
      await firestoreRequest(
        `/users/${encodeURIComponent(String(match.data.userId))}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            firestoreFields({
              subscriptionTier: "premium",
              aiRequestsLimit: 500,
            }),
          ),
        },
      );
    }

    res.status(200).json({
      ok: true,
      status: nextStatus,
      reference,
      premiumActivated: nextStatus === "paid",
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Webhook processing failed",
    });
  }
});

export default router;