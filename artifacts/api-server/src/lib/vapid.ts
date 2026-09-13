import webpush from "web-push";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import fs from "node:fs";
import path from "node:path";

/**
 * Path to the local key file used as a dev-only fallback when
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars are not set.
 * The canonical source is always the env vars — set them via
 * `pnpm --filter @workspace/api-server run setup:vapid` or in
 * the Replit Secrets panel to ensure keys survive across all
 * environments (including deployments with ephemeral filesystems).
 */
const VAPID_KEYS_FILE = path.resolve(process.cwd(), ".vapid-keys.json");

function loadOrGenerateVapidKeys(): { publicKey: string; privateKey: string } {
  // 1. Canonical source: environment variables (set once, survive all restarts)
  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];

  if (publicKey && privateKey) {
    logger.info({ publicKey }, "VAPID keys loaded from environment variables (canonical source).");
    return { publicKey, privateKey };
  }

  // 2. Local dev fallback: persisted key file (survives process restarts on the same host)
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    try {
      const raw = fs.readFileSync(VAPID_KEYS_FILE, "utf8");
      const stored = JSON.parse(raw) as { publicKey: string; privateKey: string };
      if (stored.publicKey && stored.privateKey) {
        logger.warn(
          { file: VAPID_KEYS_FILE, publicKey: stored.publicKey },
          "VAPID keys loaded from local key file (dev fallback). " +
            "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars for production.",
        );
        return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      }
    } catch (err) {
      logger.warn({ err, file: VAPID_KEYS_FILE }, "Could not read VAPID key file — regenerating.");
    }
  }

  // 3. First-run: generate fresh keys, write to the local fallback file, and instruct the user
  const keys = webpush.generateVAPIDKeys();

  try {
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err, file: VAPID_KEYS_FILE }, "Could not write VAPID key file — keys will be ephemeral this run.");
  }

  logger.warn(
    {
      vapidKeysFile: VAPID_KEYS_FILE,
      publicKey: keys.publicKey,
    },
    "Generated new VAPID keys for the first time and saved them to the local key file. " +
      "These keys will be reused via the file on this host, but will be lost on deployment " +
      "or environment rebuild. To make them permanent, set the following env vars: " +
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (values are in " +
      VAPID_KEYS_FILE +
      ").",
  );

  return keys;
}

const vapidKeys = loadOrGenerateVapidKeys();

const VAPID_SUBJECT =
  process.env["VAPID_SUBJECT"] ?? "mailto:admin@apshule.app";

webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

export const vapidPublicKey = vapidKeys.publicKey;

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const subscriptions = new Map<string, PushSubscriptionRecord>();

/** Load all persisted subscriptions from the database into the in-memory map. */
export async function loadSubscriptionsFromDb(): Promise<void> {
  const rows = await db.select().from(pushSubscriptionsTable);
  for (const row of rows) {
    subscriptions.set(row.endpoint, {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    });
  }
  logger.info({ count: rows.length }, "Push subscriptions loaded from database");
}

export async function saveSubscription(sub: PushSubscriptionRecord): Promise<void> {
  subscriptions.set(sub.endpoint, sub);
  await db
    .insert(pushSubscriptionsTable)
    .values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    .onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  subscriptions.delete(endpoint);
  await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, endpoint));
}

export function subscriptionCount(): number {
  return subscriptions.size;
}

export async function sendWebPush(
  title: string,
  body: string,
): Promise<{ sent: number; failed: number }> {
  const payload = JSON.stringify({ title, body });
  let sent = 0;
  let failed = 0;

  const stale: string[] = [];

  for (const sub of subscriptions.values()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err !== null && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 0;
      if (status === 404 || status === 410) {
        stale.push(sub.endpoint);
      }
      failed++;
      logger.warn({ endpoint: sub.endpoint, status }, "Web push delivery failed");
    }
  }

  for (const ep of stale) {
    subscriptions.delete(ep);
    db.delete(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.endpoint, ep))
      .catch((err: unknown) => {
        logger.warn({ endpoint: ep, err }, "Failed to delete stale subscription from database");
      });
  }

  return { sent, failed };
}
