import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { verifyFirebaseAdmin } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();
const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_MAX_VIDEOS = 250;
const MAX_VIDEOS = 500;

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };
type FirestoreQueryRow = { document?: FirestoreDocument };

type YouTubeChannel = {
  id: string;
  title: string;
  description: string;
  uploadsPlaylistId: string;
  thumbnailUrl: string;
};

type YouTubeVideo = {
  videoId: string;
  channelId: string;
  channelTitle: string;
  playlistId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  durationSeconds: number | null;
  privacyStatus: string;
  liveBroadcastContent: string;
};

type Placement = {
  classKey: string;
  classLevel: string;
  subject: string;
  topic: string;
};

function firestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, firestoreValue(item)]),
        ),
      },
    };
  }
  return { stringValue: String(value) };
}

function firestoreFields(data: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, firestoreValue(value)]),
    ),
  };
}

function firestoreFieldValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if ("stringValue" in item) return item.stringValue;
  if ("integerValue" in item) return Number(item.integerValue);
  if ("doubleValue" in item) return item.doubleValue;
  if ("booleanValue" in item) return item.booleanValue;
  if ("timestampValue" in item) return item.timestampValue;
  if ("nullValue" in item) return null;
  if ("mapValue" in item) {
    const fields = (item.mapValue as { fields?: Record<string, unknown> }).fields ?? {};
    return Object.fromEntries(
      Object.entries(fields).map(([key, nested]) => [key, firestoreFieldValue(nested)]),
    );
  }
  if ("arrayValue" in item) {
    return ((item.arrayValue as { values?: unknown[] }).values ?? []).map(firestoreFieldValue);
  }
  return item;
}

function firestoreDocumentData(document?: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document?.fields ?? {}).map(([key, value]) => [key, firestoreFieldValue(value)]),
  );
}

async function firestoreRequest(
  path: string,
  init: RequestInit = {},
  callerToken?: string,
): Promise<unknown> {
  const token = (await getFirebaseAdminToken()) ?? callerToken;
  if (!token) throw new Error("Firebase service account is not configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${FIRESTORE_BASE}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`Firestore request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function firestoreGet(
  collectionId: string,
  documentId: string,
  callerToken?: string,
): Promise<Record<string, unknown> | null> {
  try {
    const document = await firestoreRequest(
      `/${collectionId}/${encodeURIComponent(documentId)}`,
      {},
      callerToken,
    ) as FirestoreDocument;
    return firestoreDocumentData(document);
  } catch (error) {
    if (String(error).includes("(404)")) return null;
    throw error;
  }
}

async function firestorePatch(
  collectionId: string,
  documentId: string,
  data: Record<string, unknown>,
  callerToken?: string,
  merge = true,
): Promise<void> {
  const query = new URLSearchParams();
  if (merge) {
    for (const key of Object.keys(data)) query.append("updateMask.fieldPaths", key);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  await firestoreRequest(
    `/${collectionId}/${encodeURIComponent(documentId)}${suffix}`,
    { method: "PATCH", body: JSON.stringify(firestoreFields(data)) },
    callerToken,
  );
}

async function firestoreList(
  collectionId: string,
  callerToken?: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const token = (await getFirebaseAdminToken()) ?? callerToken;
  if (!token) throw new Error("Firebase service account is not configured");
  const response = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
  const rows = await response.json() as FirestoreQueryRow[];
  return rows.filter((row) => row.document?.name).map((row) => ({
    id: row.document?.name?.split("/").pop() ?? "",
    ...firestoreDocumentData(row.document),
  }));
}

async function requireSuperadmin(
  req: Request,
  res: Response,
): Promise<{ uid: string; token?: string } | null> {
  const result = await verifyFirebaseAdmin(req.headers.authorization);
  if (!result.ok) {
    res.status(result.status).json({ ok: false, error: result.reason });
    return null;
  }
  return {
    uid: result.uid,
    token: req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined,
  };
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeClassKey(value: unknown): { classKey: string; classLevel: string } | null {
  const raw = safeText(value, 40).toLowerCase().replace(/\s+/g, "");
  const match = raw.match(/^(primary|p|secondary|s)[_-]?([1-9]\d?)$/);
  if (!match) return null;
  const isPrimary = match[1] === "primary" || match[1] === "p";
  const number = Number(match[2]);
  if (isPrimary && (number < 1 || number > 7)) return null;
  if (!isPrimary && (number < 1 || number > 6)) return null;
  return {
    classKey: `${isPrimary ? "primary" : "secondary"}_${number}`,
    classLevel: `${isPrimary ? "P" : "S"}${number}`,
  };
}

function parsePlacement(title: string, description: string): Placement | null {
  const text = `${title}\n${description}`;
  const classMatch =
    text.match(/(?:class|level)\s*[:=]\s*(primary|secondary|p|s)\s*[_ -]?([1-9]\d?)/i) ??
    title.match(/\b(primary|secondary|p|s)\s*[_ -]?([1-9]\d?)\b/i);
  const subjectMatch = text.match(/subject\s*[:=]\s*([^\n|;]+)/i);
  const topicMatch = text.match(/topic\s*[:=]\s*([^\n|;]+)/i);
  if (!classMatch || !subjectMatch || !topicMatch) return null;

  const normalizedClass = normalizeClassKey(`${classMatch[1]}${classMatch[2]}`);
  const subject = safeText(subjectMatch[1], 100);
  const topic = safeText(topicMatch[1], 200);
  if (!normalizedClass || !subject || !topic) return null;
  return {
    ...normalizedClass,
    subject,
    topic,
  };
}

function parseChannelSelector(value: unknown): { id?: string; handle?: string; username?: string } {
  const raw = safeText(value, 300);
  if (!raw) return {};
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(raw)) return { id: raw };
  if (raw.startsWith("@")) return { handle: raw.slice(1) };
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return { id: parts[1] };
    if (parts[0]?.startsWith("@")) return { handle: parts[0].slice(1) };
    if (parts[0] === "user" && parts[1]) return { username: parts[1] };
  } catch {
    // The caller receives a validation error below when the selector is unusable.
  }
  return {};
}

async function youtubeRequest<T>(
  resource: string,
  params: Record<string, string>,
): Promise<T> {
  const apiKey = process.env["YOUTUBE_API_KEY"];
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not configured on the API server");
  const url = new URL(`${YOUTUBE_BASE}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await response.json() as {
    error?: { errors?: Array<{ reason?: string }>; message?: string };
  } & T;
  if (!response.ok) {
    if (response.status === 403) throw new Error("YouTube API access was denied or its quota was exhausted");
    if (response.status === 404) throw new Error("YouTube channel or playlist was not found");
    throw new Error(`YouTube API request failed (${response.status})`);
  }
  return data;
}

async function resolveChannel(value: unknown): Promise<YouTubeChannel> {
  const selector = parseChannelSelector(value);
  const params: Record<string, string> = { part: "snippet,contentDetails" };
  if (selector.id) params.id = selector.id;
  else if (selector.handle) params.forHandle = selector.handle;
  else if (selector.username) params.forUsername = selector.username;
  else throw new Error("A YouTube channel URL, @handle, or channel ID is required");

  const data = await youtubeRequest<{
    items?: Array<{
      id?: string;
      snippet?: {
        title?: string;
        description?: string;
        thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
      };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  }>("channels", params);
  const item = data.items?.[0];
  const id = safeText(item?.id, 100);
  const uploadsPlaylistId = safeText(item?.contentDetails?.relatedPlaylists?.uploads, 100);
  if (!id || !uploadsPlaylistId) throw new Error("The YouTube channel has no accessible uploads playlist");
  return {
    id,
    title: safeText(item?.snippet?.title, 200),
    description: safeText(item?.snippet?.description, 1000),
    uploadsPlaylistId,
    thumbnailUrl: safeText(
      item?.snippet?.thumbnails?.high?.url ?? item?.snippet?.thumbnails?.medium?.url,
      500,
    ),
  };
}

function durationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

async function fetchPlaylistVideos(
  playlistId: string,
  maxVideos: number,
): Promise<YouTubeVideo[]> {
  const playlistItems: Array<{
    videoId: string;
    title: string;
    description: string;
    thumbnailUrl: string;
    publishedAt: string;
  }> = [];
  let pageToken = "";
  while (playlistItems.length < maxVideos) {
    const data = await youtubeRequest<{
      nextPageToken?: string;
      items?: Array<{
        snippet?: {
          title?: string;
          description?: string;
          publishedAt?: string;
          thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
        };
        contentDetails?: { videoId?: string };
        status?: { privacyStatus?: string };
      }>;
    }>("playlistItems", {
      part: "snippet,contentDetails,status",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items ?? []) {
      const videoId = safeText(item.contentDetails?.videoId, 20);
      if (!videoId || item.status?.privacyStatus === "private") continue;
      playlistItems.push({
        videoId,
        title: safeText(item.snippet?.title, 500),
        description: safeText(item.snippet?.description, 5000),
        thumbnailUrl: safeText(
          item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url,
          500,
        ),
        publishedAt: safeText(item.snippet?.publishedAt, 80),
      });
      if (playlistItems.length >= maxVideos) break;
    }
    if (!data.nextPageToken || !(data.items?.length ?? 0)) break;
    pageToken = data.nextPageToken;
  }

  const details = new Map<string, {
    channelId: string;
    channelTitle: string;
    duration: number | null;
    privacyStatus: string;
    liveBroadcastContent: string;
  }>();
  for (let index = 0; index < playlistItems.length; index += 50) {
    const ids = playlistItems.slice(index, index + 50).map((item) => item.videoId).join(",");
    const data = await youtubeRequest<{
      items?: Array<{
        id?: string;
        snippet?: {
          channelId?: string;
          channelTitle?: string;
          liveBroadcastContent?: string;
        };
        contentDetails?: { duration?: string };
        status?: { privacyStatus?: string };
      }>;
    }>("videos", { part: "snippet,contentDetails,status", id: ids });
    for (const item of data.items ?? []) {
      const id = safeText(item.id, 20);
      if (!id) continue;
      details.set(id, {
        channelId: safeText(item.snippet?.channelId, 100),
        channelTitle: safeText(item.snippet?.channelTitle, 200),
        duration: durationSeconds(item.contentDetails?.duration),
        privacyStatus: safeText(item.status?.privacyStatus, 40),
        liveBroadcastContent: safeText(item.snippet?.liveBroadcastContent, 40),
      });
    }
  }

  return playlistItems.flatMap((item) => {
    const detail = details.get(item.videoId);
    if (!detail || detail.privacyStatus === "private") return [];
    return [{
      videoId: item.videoId,
      channelId: detail.channelId,
      channelTitle: detail.channelTitle,
      playlistId,
      title: item.title,
      description: item.description,
      thumbnailUrl: item.thumbnailUrl,
      publishedAt: item.publishedAt,
      durationSeconds: detail.duration,
      privacyStatus: detail.privacyStatus,
      liveBroadcastContent: detail.liveBroadcastContent,
    }];
  });
}

async function importVideo(
  video: YouTubeVideo,
  adminUid: string,
  callerToken?: string,
): Promise<{
  videoId: string;
  title: string;
  mappingStatus: "mapped" | "unmapped" | "conflict";
  mappingKey?: string;
  classKey?: string;
  subject?: string;
  topic?: string;
}> {
  const placement = parsePlacement(video.title, video.description);
  const baseRecord: Record<string, unknown> = {
    videoId: video.videoId,
    youtubeId: video.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    source: "youtube_channel",
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    playlistId: video.playlistId,
    title: video.title,
    description: video.description,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    privacyStatus: video.privacyStatus,
    liveBroadcastContent: video.liveBroadcastContent,
    syncedAt: new Date().toISOString(),
    syncedBy: adminUid,
  };
  if (placement) {
    baseRecord.suggestedClassKey = placement.classKey;
    baseRecord.suggestedClassLevel = placement.classLevel;
    baseRecord.suggestedSubject = placement.subject;
    baseRecord.suggestedTopic = placement.topic;
  }
  await firestorePatch("youtubeVideos", video.videoId, baseRecord, callerToken, true);

  if (!placement) {
    await firestorePatch("youtubeVideos", video.videoId, {
      mappingStatus: "unmapped",
      mappingKey: null,
    }, callerToken, true);
    return { videoId: video.videoId, title: video.title, mappingStatus: "unmapped" };
  }

  const mappingKey = `${placement.classKey}_${placement.subject}`;
  const existing = await firestoreGet("videoMappings", mappingKey, callerToken);
  const existingVideoId = safeText(existing?.youtubeId, 20);
  if (existingVideoId && existingVideoId !== video.videoId) {
    await firestorePatch("youtubeVideos", video.videoId, {
      mappingStatus: "conflict",
      mappingKey,
    }, callerToken, true);
    return {
      videoId: video.videoId,
      title: video.title,
      mappingStatus: "conflict",
      mappingKey,
      classKey: placement.classKey,
      subject: placement.subject,
      topic: placement.topic,
    };
  }

  await firestorePatch("videoMappings", mappingKey, {
    ...(existing ?? {}),
    subject: placement.subject,
    classKey: placement.classKey,
    youtubeId: video.videoId,
    teacherId: existing?.teacherId ?? "",
    topic: placement.topic,
    title: video.title,
    source: "youtube_channel",
    youtubeVideoId: video.videoId,
    playlistId: video.playlistId,
    channelId: video.channelId,
    updatedBy: adminUid,
    updatedAt: new Date().toISOString(),
  }, callerToken, false);
  await firestorePatch("youtubeVideos", video.videoId, {
    mappingStatus: "mapped",
    mappingKey,
    classKey: placement.classKey,
    classLevel: placement.classLevel,
    subject: placement.subject,
    topic: placement.topic,
  }, callerToken, true);
  return {
    videoId: video.videoId,
    title: video.title,
    mappingStatus: "mapped",
    mappingKey,
    classKey: placement.classKey,
    subject: placement.subject,
    topic: placement.topic,
  };
}

function sendYouTubeError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "YouTube integration failed";
  if (/not configured/.test(message)) {
    res.status(503).json({ ok: false, error: message });
    return;
  }
  if (/required|invalid|unusable/.test(message)) {
    res.status(400).json({ ok: false, error: message });
    return;
  }
  if (/denied|quota|not found|request failed/.test(message)) {
    res.status(502).json({ ok: false, error: message });
    return;
  }
  res.status(500).json({ ok: false, error: "YouTube integration failed" });
}

router.get("/youtube/status", async (req, res) => {
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;
  res.json({
    ok: true,
    configured: Boolean(process.env["YOUTUBE_API_KEY"]),
    channelConfigured: Boolean(process.env["YOUTUBE_CHANNEL_ID"] || process.env["YOUTUBE_CHANNEL_URL"]),
    importedCollection: "youtubeVideos",
    mappingCollection: "videoMappings",
  });
});

router.get("/youtube/videos", async (req, res) => {
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;
  try {
    const rows = await firestoreList("youtubeVideos", admin.token);
    const limit = Math.min(MAX_VIDEOS, Math.max(1, Number(req.query.limit ?? DEFAULT_MAX_VIDEOS) || DEFAULT_MAX_VIDEOS));
    rows.sort((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? "")));
    res.json({ ok: true, videos: rows.slice(0, limit) });
  } catch {
    res.status(500).json({ ok: false, error: "Unable to load imported YouTube videos" });
  }
});

router.post("/youtube/sync", async (req, res) => {
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;
  try {
    const channelInput =
      req.body?.channelUrl ??
      req.body?.channelId ??
      process.env["YOUTUBE_CHANNEL_URL"] ??
      process.env["YOUTUBE_CHANNEL_ID"];
    const channel = await resolveChannel(channelInput);
    const requestedMax = Number(req.body?.maxVideos ?? DEFAULT_MAX_VIDEOS);
    const maxVideos = Number.isFinite(requestedMax)
      ? Math.min(MAX_VIDEOS, Math.max(1, Math.floor(requestedMax)))
      : DEFAULT_MAX_VIDEOS;
    const videos = await fetchPlaylistVideos(channel.uploadsPlaylistId, maxVideos);
    const results = [];
    for (const video of videos) {
      results.push(await importVideo(video, admin.uid, admin.token));
    }
    const summary = {
      mapped: results.filter((item) => item.mappingStatus === "mapped").length,
      unmapped: results.filter((item) => item.mappingStatus === "unmapped").length,
      conflicts: results.filter((item) => item.mappingStatus === "conflict").length,
    };
    await firestorePatch("youtubeSyncRuns", randomUUID(), {
      channelId: channel.id,
      channelTitle: channel.title,
      playlistId: channel.uploadsPlaylistId,
      importedCount: videos.length,
      ...summary,
      syncedBy: admin.uid,
      syncedAt: new Date().toISOString(),
    }, admin.token, false);
    res.json({
      ok: true,
      channel,
      playlist: {
        id: channel.uploadsPlaylistId,
        title: `${channel.title} uploads`,
      },
      importedCount: videos.length,
      ...summary,
      results,
    });
  } catch (error) {
    sendYouTubeError(res, error);
  }
});

router.post("/youtube/mappings", async (req, res) => {
  const admin = await requireSuperadmin(req, res);
  if (!admin) return;
  const videoId = safeText(req.body?.videoId ?? req.body?.youtubeId, 20);
  const subject = safeText(req.body?.subject, 100);
  const topic = safeText(req.body?.topic, 200);
  const classValue = req.body?.classKey ?? req.body?.classLevel ?? req.body?.class;
  const normalizedClass = normalizeClassKey(classValue);
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !subject || !normalizedClass) {
    res.status(400).json({
      ok: false,
      error: "videoId, subject, and a valid classKey/classLevel are required",
    });
    return;
  }
  const mappingKey = `${normalizedClass.classKey}_${subject}`;
  try {
    const existing = await firestoreGet("videoMappings", mappingKey, admin.token);
    await firestorePatch("videoMappings", mappingKey, {
      ...(existing ?? {}),
      subject,
      classKey: normalizedClass.classKey,
      youtubeId: videoId,
      teacherId: safeText(req.body?.teacherId, 200),
      topic,
      source: "youtube_channel",
      youtubeVideoId: videoId,
      updatedBy: admin.uid,
      updatedAt: new Date().toISOString(),
    }, admin.token, false);
    const imported = await firestoreGet("youtubeVideos", videoId, admin.token);
    if (imported) {
      await firestorePatch("youtubeVideos", videoId, {
        mappingStatus: "mapped",
        mappingKey,
        classKey: normalizedClass.classKey,
        classLevel: normalizedClass.classLevel,
        subject,
        topic,
      }, admin.token, true);
    }
    res.json({
      ok: true,
      mapping: {
        id: mappingKey,
        youtubeId: videoId,
        classKey: normalizedClass.classKey,
        classLevel: normalizedClass.classLevel,
        subject,
        topic,
      },
    });
  } catch {
    res.status(500).json({ ok: false, error: "Unable to save YouTube placement mapping" });
  }
});

export default router;