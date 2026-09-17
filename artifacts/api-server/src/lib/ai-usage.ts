import { randomUUID } from "node:crypto";
import { getFirebaseAdminToken } from "./firebase-admin-token";

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const USAGE_COLLECTION = "user_usage";
export const FREE_DAILY_AI_LIMIT = 10;

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, Record<string, unknown>>;
};

function firestoreValue(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
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

function firestoreFieldValue(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  return undefined;
}

async function firestoreRequest(path: string, init: RequestInit, callerToken: string) {
  const adminToken = await getFirebaseAdminToken();
  const token = adminToken ?? callerToken;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${FIRESTORE_BASE}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`Firestore usage request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function recentUsage(uid: string, callerToken: string): Promise<Array<{ timestamp: string }>> {
  const response = await firestoreRequest(
    ":runQuery",
    {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: USAGE_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: "userId" },
              op: "EQUAL",
              value: firestoreValue(uid),
            },
          },
        },
      }),
    },
    callerToken,
  ) as Array<{ document?: FirestoreDocument }>;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return response
    .map((row) => row.document)
    .filter((document): document is FirestoreDocument => Boolean(document))
    .map((document) => ({
      timestamp: String(firestoreFieldValue(document.fields?.timestamp) ?? ""),
    }))
    .filter((item) => {
      const timestamp = Date.parse(item.timestamp);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
}

async function recordUsage(
  uid: string,
  callerToken: string,
  count: number,
  blocked: boolean,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const usageId = `${uid}-${Date.now()}-${randomUUID().slice(0, 12)}`;
  await firestoreRequest(
    `/${USAGE_COLLECTION}/${encodeURIComponent(usageId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(
        firestoreFields({
          userId: uid,
          timestamp,
          count,
          blocked,
          source: "ai_assistant",
        }),
      ),
    },
    callerToken,
  );
}

/**
 * Phase 2 placeholder: premium entitlement should be connected to the
 * completed payment/subscription record instead of only the user profile.
 */
export async function checkAndRecordAiUsage(
  uid: string,
  callerToken: string,
  isPremium: boolean,
): Promise<{ allowed: boolean; count: number }> {
  const current = await recentUsage(uid, callerToken);
  const count = current.length + 1;
  const allowed = isPremium || count <= FREE_DAILY_AI_LIMIT;
  await recordUsage(uid, callerToken, count, !allowed);
  return { allowed, count };
}