import { Router, type IRouter } from "express";
import {
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  subscriptionCount,
  type PushSubscriptionRecord,
} from "../lib/vapid";
import { isAuthorized } from "../lib/push-secret";

const router: IRouter = Router();

const MAX_SUBSCRIPTIONS = 50;

/** Public — the browser needs the VAPID public key to create a subscription. */
router.get("/push-subscription/vapid-public-key", (_req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

/**
 * Register a push subscription.
 * No auth secret required — only a browser that received the VAPID public key
 * and passed the browser's own push permission flow can produce a valid
 * PushSubscription. A hard cap on stored subscriptions limits amplification.
 */
router.post("/push-subscription", async (req, res) => {
  if (subscriptionCount() >= MAX_SUBSCRIPTIONS) {
    res
      .status(429)
      .json({ error: "Too many subscriptions registered. Remove old ones first." });
    return;
  }

  const body = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (
    !body.endpoint ||
    typeof body.endpoint !== "string" ||
    !body.keys?.p256dh ||
    !body.keys?.auth
  ) {
    res
      .status(400)
      .json({ error: "endpoint, keys.p256dh, and keys.auth are required" });
    return;
  }

  const sub: PushSubscriptionRecord = {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
  };

  await saveSubscription(sub);
  req.log.info({ endpoint: sub.endpoint }, "Push subscription registered");
  res.status(201).json({ ok: true });
});

/**
 * Remove a push subscription.
 * Guarded by the push secret when one is configured.
 */
router.delete("/push-subscription", async (req, res) => {
  const warn = (msg: string) => req.log.warn(msg);
  if (
    !isAuthorized(
      req.headers["authorization"],
      req.headers["x-push-secret"] as string | undefined,
      warn,
    )
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as { endpoint?: string };

  if (!body.endpoint || typeof body.endpoint !== "string") {
    res.status(400).json({ error: "endpoint is required" });
    return;
  }

  await removeSubscription(body.endpoint);
  req.log.info({ endpoint: body.endpoint }, "Push subscription removed");
  res.json({ ok: true });
});

export default router;
