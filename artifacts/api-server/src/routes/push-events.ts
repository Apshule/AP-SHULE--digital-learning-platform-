import { Router, type IRouter, type Response } from "express";
import { sendWebPush } from "../lib/vapid";
import { isAuthorized } from "../lib/push-secret";
import { loadHistory, saveHistory, type PushEvent } from "../lib/push-history-store";
import { verifyFirebaseAdmin } from "../lib/firebase-auth";

const router: IRouter = Router();

const clients = new Set<Response>();

const HISTORY_LIMIT = 50;

const pushHistory: PushEvent[] = loadHistory(HISTORY_LIMIT);

function recordEvent(event: PushEvent) {
  pushHistory.unshift(event);
  if (pushHistory.length > HISTORY_LIMIT) {
    pushHistory.length = HISTORY_LIMIT;
  }
  saveHistory(pushHistory);
}

router.get("/push-events/history", (req, res) => {
  res.json(pushHistory);
});

router.delete("/push-events/history", async (req, res) => {
  const result = await verifyFirebaseAdmin(req.headers["authorization"]);
  if (!result.ok) {
    res.status(result.status).json({ error: result.reason });
    return;
  }
  pushHistory.length = 0;
  saveHistory(pushHistory);
  req.log.info({ uid: result.uid }, "Push history cleared by admin");
  res.json({ ok: true });
});

router.get("/push-events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write("retry: 3000\n\n");

  clients.add(res);
  req.log.info({ clientCount: clients.size }, "SSE client connected");

  req.on("close", () => {
    clients.delete(res);
    req.log.info({ clientCount: clients.size }, "SSE client disconnected");
  });
});

router.post("/push-events", async (req, res) => {
  const warn = (msg: string) => req.log.warn(msg);
  if (!isAuthorized(req.headers["authorization"], req.headers["x-push-secret"] as string | undefined, warn)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { type, message } = req.body as { type?: string; message?: string };

  if (!type || !message) {
    res.status(400).json({ error: "type and message are required" });
    return;
  }

  if (type !== "success" && type !== "error") {
    res.status(400).json({ error: "type must be 'success' or 'error'" });
    return;
  }

  recordEvent({ type, message, timestamp: new Date().toISOString() });

  const payload = JSON.stringify({ type, message });
  const event = `event: push-${type}\ndata: ${payload}\n\n`;

  let notified = 0;
  for (const client of clients) {
    try {
      client.write(event);
      notified++;
    } catch {
      clients.delete(client);
    }
  }

  req.log.info({ type, notified }, "Push event broadcast via SSE");

  const title = type === "success" ? "APSHULE Push ✅" : "APSHULE Push ❌";
  const body = (type === "success" ? "✅ " : "❌ ") + message;
  const { sent, failed } = await sendWebPush(title, body);

  req.log.info({ sent, failed }, "Push event broadcast via Web Push");

  res.json({ ok: true, notified, webPush: { sent, failed } });
});

export default router;
