import { Router, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  caRecordsTable,
  computeTextSimilarity,
  createProjectRecord,
  generateProjectLin,
  getCurrentTermLabel,
  getProjectMilestoneUploadError,
  curriculumLinksTable,
  db,
  normalizeProjectTitle,
  projectsTable,
  teacherRetoolingProgressTable,
  unebItemsTable,
  validateProjectFields,
} from "@workspace/db";
import { createHash, randomUUID } from "node:crypto";

const router = Router();
const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const GOOGLE_API_KEY = process.env["GOOGLE_API_KEY"];
const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

type Caller = {
  uid: string;
  role: string;
  schoolId?: string;
  subject?: string;
  classes?: string[];
  name?: string;
  lin?: string;
};

function firestoreValue(fields: Record<string, unknown> | undefined, key: string): unknown {
  const value = fields?.[key] as Record<string, unknown> | undefined;
  return value?.stringValue ?? value?.integerValue ?? value?.booleanValue;
}

async function getCaller(req: Request): Promise<Caller | null> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const uid = String(payload["user_id"] ?? "");
    if (!uid) return null;
    const url =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${uid}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const document = (await response.json()) as { fields?: Record<string, unknown> };
    const role = String(firestoreValue(document.fields, "role") ?? "individual");
    const classesRaw = firestoreValue(document.fields, "classes");
    const classes = Array.isArray(classesRaw) ? classesRaw.map(String) : [];
    return {
      uid,
      role,
      name: String(
        firestoreValue(document.fields, "name") ??
        firestoreValue(document.fields, "displayName") ??
        "",
      ) || undefined,
      schoolId: String(firestoreValue(document.fields, "schoolId") ?? "") || undefined,
      subject: String(firestoreValue(document.fields, "subject") ?? "") || undefined,
      classes,
      lin: String(firestoreValue(document.fields, "lin") ?? firestoreValue(document.fields, "learnerId") ?? "") || undefined,
    };
  } catch {
    return null;
  }
}

function requireCaller(req: Request, res: Response): Promise<Caller | null> {
  return getCaller(req).then((caller) => {
    if (!caller) {
      res.status(401).json({ ok: false, error: "A valid APSHULE login is required" });
      return null;
    }
    return caller;
  });
}

function canSeeProject(caller: Caller, project: typeof projectsTable.$inferSelect): boolean {
  if (caller.role === "superadmin") return true;
  if (caller.role === "individual") return project.learnerId === caller.uid;
  if (caller.schoolId && project.schoolId !== caller.schoolId) return false;
  if (caller.role === "teacher" && caller.subject && project.subject !== caller.subject) return false;
  if (caller.role === "school" || caller.role === "teacher") return true;
  return false;
}

function decodedDataUrlBytes(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const base64 = value.slice(comma + 1).replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function isAllowedProjectPhoto(value: string): boolean {
  if (value.startsWith("data:image/")) return decodedDataUrlBytes(value) <= 500 * 1024;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "firebasestorage.googleapis.com" ||
      url.hostname === "storage.googleapis.com" ||
      url.hostname.endsWith(".firebasestorage.app")
    );
  } catch {
    return false;
  }
}

function isAllowedProjectAudio(value: string): boolean {
  if (value.startsWith("data:audio/")) return decodedDataUrlBytes(value) <= 2 * 1024 * 1024;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "firebasestorage.googleapis.com" ||
      url.hostname === "storage.googleapis.com" ||
      url.hostname.endsWith(".firebasestorage.app")
    );
  } catch {
    return false;
  }
}

function buildQrPayload(input: {
  projectId: string;
  lin: string;
  learnerId: string;
  schoolId: string;
  title: string;
  term: string;
  issuedAt: Date;
}) {
  const unsigned = {
    version: 1,
    projectId: input.projectId,
    lin: input.lin,
    learnerId: input.learnerId,
    schoolId: input.schoolId,
    title: input.title,
    term: input.term,
    issuedAt: input.issuedAt.toISOString(),
  };
  const hash = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  return {
    payload: JSON.stringify({ ...unsigned, hash }),
    code: `APSHULE-QR-${hash.slice(0, 20).toUpperCase()}`,
    hash,
  };
}

function parsePhotoHash(value: unknown): { milestone: string; hash: string } | null {
  if (typeof value !== "string") return null;
  const hash = value.trim().toLowerCase();
  if (/^[a-f0-9]{16,128}$/.test(hash)) return { milestone: "unknown", hash };
  try {
    const parsed = JSON.parse(value) as { milestone?: string; hash?: string };
    if (parsed && typeof parsed.hash === "string" && /^[a-f0-9]{16,128}$/.test(parsed.hash)) {
      return { milestone: String(parsed.milestone ?? "unknown"), hash: parsed.hash.toLowerCase() };
    }
  } catch {
    // Legacy photo hash entries were plain strings.
  }
  return null;
}

function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = parseInt(left[index], 16) ^ parseInt(right[index], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

function milestoneFields(milestone: string) {
  return {
    "1": {
      date: projectsTable.milestone1Date,
      photo: projectsTable.milestone1Photo,
      status: projectsTable.milestone1Status,
      uploadedAt: projectsTable.milestone1UploadedAt,
      approvedAt: projectsTable.milestone1ApprovedAt,
      rejectedAt: projectsTable.milestone1RejectedAt,
      comment: projectsTable.milestone1Comment,
    },
    "2": {
      date: projectsTable.milestone2Date,
      photo: projectsTable.milestone2Photo,
      status: projectsTable.milestone2Status,
      uploadedAt: projectsTable.milestone2UploadedAt,
      approvedAt: projectsTable.milestone2ApprovedAt,
      rejectedAt: projectsTable.milestone2RejectedAt,
      comment: projectsTable.milestone2Comment,
    },
    "3": {
      date: projectsTable.finalDate,
      photo: projectsTable.finalPhoto,
      status: projectsTable.finalStatus,
      uploadedAt: projectsTable.finalUploadedAt,
      approvedAt: projectsTable.finalApprovedAt,
      rejectedAt: projectsTable.finalRejectedAt,
      comment: projectsTable.finalComment,
    },
    final: {
      date: projectsTable.finalDate,
      photo: projectsTable.finalPhoto,
      status: projectsTable.finalStatus,
      uploadedAt: projectsTable.finalUploadedAt,
      approvedAt: projectsTable.finalApprovedAt,
      rejectedAt: projectsTable.finalRejectedAt,
      comment: projectsTable.finalComment,
    },
  }[milestone] ?? null;
}

async function generateWithGemini(prompt: string, signal?: AbortSignal): Promise<string> {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured");
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" +
      `?key=${encodeURIComponent(GOOGLE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.35 },
      }),
    },
  );
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(data.error?.message ?? "Gemini request failed");
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

router.get("/compliance/projects", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const rows = await db.select().from(projectsTable).orderBy(desc(projectsTable.createdAt));
  const className = String(req.query.className ?? "").trim();
  const subject = String(req.query.subject ?? "").trim();
  const visible = rows.filter((project) =>
    canSeeProject(caller, project) &&
    (!className || project.className === className) &&
    (!subject || project.subject === subject),
  );
  res.json({ ok: true, projects: visible });
});

router.post("/compliance/projects", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "individual" && caller.role !== "student") {
    res.status(403).json({ ok: false, error: "Only learners can create projects" });
    return;
  }
  const body = req.body as {
    schoolId?: string;
    className?: string;
    subject?: string;
    title?: string;
    description?: string;
    lin?: string;
    term?: string;
    improvementNote?: string;
    qrDataUrl?: string;
  };
  const title = String(body.title ?? "").trim();
  const schoolId = String(body.schoolId ?? "").trim();
  const className = String(body.className ?? "").trim();
  const subject = String(body.subject ?? "").trim();
  const description = String(body.description ?? "").trim().slice(0, 300);
  const term = String(body.term ?? getCurrentTermLabel()).trim().slice(0, 20);
  const improvementNote = String(body.improvementNote ?? "").trim().slice(0, 500);
  const titleNormalized = normalizeProjectTitle(title);
  const requestedLin = String(body.lin ?? "").trim();
  if (!title || title.length > 100 || !schoolId || !className || !subject) {
    res.status(400).json({ ok: false, error: "schoolId, className, subject and title are required" });
    return;
  }
  const previous = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(
      eq(projectsTable.learnerId, caller.uid),
      sql`coalesce(${projectsTable.titleNormalized}, lower(trim(${projectsTable.title}))) = ${titleNormalized}`,
      eq(projectsTable.term, term),
    ));
  if (previous.length) {
    res.status(409).json({
      ok: false,
      code: "DUPLICATE_CURRENT_TERM",
      error: "This project title has already been used this term",
    });
    return;
  }
  const [previousProject] = await db
    .select({
      id: projectsTable.id,
      title: projectsTable.title,
      term: projectsTable.term,
    })
    .from(projectsTable)
    .where(and(
      eq(projectsTable.learnerId, caller.uid),
      sql`coalesce(${projectsTable.titleNormalized}, lower(trim(${projectsTable.title}))) = ${titleNormalized}`,
    ))
    .orderBy(desc(projectsTable.createdAt))
    .limit(1);
  if (previousProject && previousProject.term !== term && improvementNote.length < 20) {
    res.status(409).json({
      ok: false,
      code: "PREVIOUS_TERM_REPEAT",
      error: "This title was used in a previous term. Add at least 20 characters explaining what is improved.",
      previousProjectId: previousProject.id,
      previousTitle: previousProject.title,
      previousTerm: previousProject.term,
      improvementRequired: true,
    });
    return;
  }
  if (caller.schoolId && caller.schoolId !== schoolId) {
    res.status(403).json({ ok: false, error: "The project school must match your school account" });
    return;
  }
  const id = randomUUID();
  const now = new Date();
  const existingLearnerProject = await db
    .select({ lin: projectsTable.lin })
    .from(projectsTable)
    .where(and(eq(projectsTable.learnerId, caller.uid), sql`${projectsTable.lin} is not null`))
    .orderBy(projectsTable.createdAt)
    .limit(1);
  let chosenLin = String(existingLearnerProject[0]?.lin ?? caller.lin ?? requestedLin ?? "").trim();
  if (!chosenLin) chosenLin = generateProjectLin(schoolId, caller.uid, now.getUTCFullYear());
  const [linCollision] = await db.select({ id: projectsTable.id, learnerId: projectsTable.learnerId })
    .from(projectsTable)
    .where(eq(projectsTable.lin, chosenLin))
    .limit(1);
  if (linCollision && linCollision.learnerId !== caller.uid) {
    chosenLin = `${chosenLin}-${caller.uid.slice(-6).toUpperCase()}`;
  }
  const qr = buildQrPayload({
    projectId: id,
    lin: chosenLin,
    learnerId: caller.uid,
    schoolId,
    title,
    term,
    issuedAt: now,
  });
  const similarityCandidates = await db
    .select({
      id: projectsTable.id,
      title: projectsTable.title,
      description: projectsTable.description,
      learnerName: projectsTable.learnerName,
    })
    .from(projectsTable)
    .where(eq(projectsTable.schoolId, schoolId));
  const similarityMatch = similarityCandidates
    .map((candidate) => ({
      ...candidate,
      score: computeTextSimilarity(`${title} ${description}`, `${candidate.title} ${candidate.description ?? ""}`),
    }))
    .sort((left, right) => right.score - left.score)[0];
  const similarityFlag = Boolean(similarityMatch && similarityMatch.score >= 0.82);
  const project = createProjectRecord({
    id,
    learnerId: caller.uid,
    learnerName: caller.name || caller.uid,
    schoolId,
    className,
    subject,
    title,
    description: description || null,
    lin: chosenLin,
    qrCode: qr.code,
    qrPayload: qr.payload,
    qrDataUrl: typeof body.qrDataUrl === "string" && body.qrDataUrl.startsWith("data:image/") ? body.qrDataUrl : null,
    qrGeneratedAt: now,
    term,
    titleNormalized,
    previousTitleCheck: true,
    previousTitleMatch: Boolean(previousProject),
    createdAt: now,
    updatedAt: now,
  });
  project.previousTitle = previousProject?.title ?? null;
  project.previousTerm = previousProject?.term ?? null;
  project.improvementNote = improvementNote || null;
  project.previousProjectId = previousProject?.id ?? null;
  project.similarityFlag = similarityFlag;
  project.similarityMatchId = similarityFlag ? similarityMatch?.id ?? null : null;
  project.similarityReason = similarityFlag
    ? `Project text is ${(similarityMatch!.score * 100).toFixed(0)}% similar to ${similarityMatch!.learnerName || "another learner"}'s project`
    : null;
  project.similarityScore = similarityFlag ? similarityMatch?.score ?? null : null;
  const missingFields = validateProjectFields(project);
  if (missingFields.length) {
    res.status(400).json({ ok: false, error: "Project is missing required fields", missingFields });
    return;
  }
  await db.insert(projectsTable).values(project);
  res.status(201).json({ ok: true, project });
});

router.patch("/compliance/projects/:id/milestones/:milestone", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "individual" && caller.role !== "student") {
    res.status(403).json({ ok: false, error: "Only learners can upload milestones" });
    return;
  }
  const milestone = req.params.milestone;
  const fields = milestoneFields(milestone);
  const photo = typeof req.body?.photo === "string" ? req.body.photo : "";
  if (!fields || !photo || !isAllowedProjectPhoto(photo)) {
    res.status(400).json({ ok: false, error: "Choose a milestone and a compressed photo under 500KB" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || project.learnerId !== caller.uid) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  const uploadError = getProjectMilestoneUploadError(project, milestone);
  if (uploadError) {
    res.status(409).json({ ok: false, error: uploadError });
    return;
  }
  const gpsLat = Number(req.body?.gpsLat);
  const gpsLng = Number(req.body?.gpsLng);
  const requestedDeviceType = String(req.body?.deviceType ?? "");
  const requestedConnection = String(req.body?.uploadedFromConnection ?? "");
  const photoHash = parsePhotoHash(req.body?.photoHash);
  const schoolProjects = photoHash
    ? await db.select({
      id: projectsTable.id,
      learnerName: projectsTable.learnerName,
      photoHashes: projectsTable.photoHashes,
    }).from(projectsTable).where(eq(projectsTable.schoolId, project.schoolId))
    : [];
  const matchingPhoto = photoHash
    ? schoolProjects
      .filter((candidate) => candidate.id !== project.id)
      .flatMap((candidate) => (candidate.photoHashes ?? [])
        .map((value) => ({ candidate, parsed: parsePhotoHash(value) }))
        .filter((entry): entry is { candidate: typeof candidate; parsed: { milestone: string; hash: string } } => Boolean(entry.parsed)))
      .map((entry) => ({ ...entry, distance: hammingDistance(entry.parsed.hash, photoHash.hash) }))
      .filter((entry) => entry.distance <= 6)
      .sort((left, right) => left.distance - right.distance)[0]
    : undefined;
  const now = new Date();
  const nextHashes = [...(project.photoHashes ?? [])];
  if (photoHash) {
    nextHashes.push(JSON.stringify({ milestone, hash: photoHash.hash, uploadedAt: now.toISOString() }));
  }
  await db
    .update(projectsTable)
    .set({
      [fields.date.name]: now,
      [fields.photo.name]: photo,
      [fields.status.name]: "pending",
      [fields.uploadedAt.name]: now,
      [fields.rejectedAt.name]: null,
      photoHashes: nextHashes,
      similarityFlag: Boolean(project.similarityFlag || matchingPhoto),
      similarityMatchId: matchingPhoto?.candidate.id ?? project.similarityMatchId,
      similarityReason: matchingPhoto
        ? `Milestone ${milestone} photo is visually similar to ${matchingPhoto.candidate.learnerName || "another learner"}'s evidence`
        : project.similarityReason,
      similarityScore: matchingPhoto
        ? Math.max(project.similarityScore ?? 0, 1 - matchingPhoto.distance / 64)
        : project.similarityScore,
      schoolGpsLat: Number.isFinite(gpsLat) ? gpsLat : null,
      schoolGpsLng: Number.isFinite(gpsLng) ? gpsLng : null,
      deviceType: ["phone", "tablet", "laptop", "desktop"].includes(requestedDeviceType) ? requestedDeviceType : null,
      uploadedFromConnection: ["offline", "mobile_data", "wifi"].includes(requestedConnection)
        ? requestedConnection
        : null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, project.id));
  res.json({
    ok: true,
    similarityFlag: Boolean(project.similarityFlag || matchingPhoto),
    similarityMatchId: matchingPhoto?.candidate.id ?? project.similarityMatchId ?? null,
  });
});

router.patch("/compliance/projects/:id/review", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can review projects" });
    return;
  }
  const status = req.body?.status === "approved" ? "approved" : "rejected";
  const milestone = String(req.body?.milestone ?? "final");
  const fields = milestoneFields(milestone);
  if (!fields) {
    res.status(400).json({ ok: false, error: "milestone must be 1, 2 or 3" });
    return;
  }
  const comment = String(req.body?.comment ?? "").trim().slice(0, 500);
  const observed = Boolean(req.body?.observed);
  const approveWithoutViva = Boolean(req.body?.approveWithoutViva);
  const vivaAudioPath = typeof req.body?.vivaAudioPath === "string" ? req.body.vivaAudioPath : "";
  if (status === "rejected" && !comment) {
    res.status(400).json({ ok: false, error: "A rejection comment is required" });
    return;
  }
  if (status === "approved" && !observed && !approveWithoutViva) {
    res.status(400).json({ ok: false, error: "Confirm that the student was observed or use the approve-without-viva override" });
    return;
  }
  if (vivaAudioPath && !isAllowedProjectAudio(vivaAudioPath)) {
    res.status(400).json({ ok: false, error: "Viva audio must be an approved Firebase Storage URL or a small audio data URL" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || !canSeeProject(caller, project)) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  const now = new Date();
  const updateValues = {
    [fields.status.name]: status,
    [fields.comment.name]: comment || null,
    [fields.approvedAt.name]: status === "approved" ? now : null,
    [fields.rejectedAt.name]: status === "rejected" ? now : null,
    teacherObservedTick: observed || project.teacherObservedTick,
    vivaAudioPath: vivaAudioPath || project.vivaAudioPath,
    vivaAudioUploadedAt: vivaAudioPath ? now : project.vivaAudioUploadedAt,
    vivaAudioMilestone: vivaAudioPath ? milestone : project.vivaAudioMilestone,
    verifiedBy: caller.uid,
    verifiedAt: now,
    completedAt: status === "approved" && milestone === "3" ? now : project.completedAt,
    updatedAt: now,
  };
  await db
    .update(projectsTable)
    .set(updateValues)
    .where(eq(projectsTable.id, project.id));
  if (status === "approved") {
    await db.insert(caRecordsTable).values({
      id: randomUUID(),
      projectId: project.id,
      milestone,
      learnerId: project.learnerId,
      schoolId: project.schoolId,
      subject: project.subject,
      competency: "Project work and communication",
      evidence1: "Project milestone evidence",
      evidence2: observed ? "Teacher observed" : "Teacher review override",
      evidence3: `${milestone === "3" ? "Final" : `Milestone ${milestone}`} project photo`,
      finalLevel: "Meets",
      term: String(req.body?.term ?? project.term ?? getCurrentTermLabel()),
      teacherId: caller.uid,
    });
  }
  res.json({ ok: true, projectId: project.id, milestone, status });
});

router.patch("/compliance/projects/:id/qr", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || (project.learnerId !== caller.uid && !canSeeProject(caller, project))) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  const qrDataUrl = typeof req.body?.qrDataUrl === "string" ? req.body.qrDataUrl : "";
  const qrStorageUrl = typeof req.body?.qrStorageUrl === "string" ? req.body.qrStorageUrl : "";
  const validStorageUrl = (() => {
    if (!qrStorageUrl) return true;
    try {
      const url = new URL(qrStorageUrl);
      return url.protocol === "https:" && (
        url.hostname === "firebasestorage.googleapis.com" ||
        url.hostname === "storage.googleapis.com" ||
        url.hostname.endsWith(".firebasestorage.app")
      );
    } catch {
      return false;
    }
  })();
  if ((!qrDataUrl.startsWith("data:image/") || decodedDataUrlBytes(qrDataUrl) > 350 * 1024) && !qrStorageUrl) {
    res.status(400).json({ ok: false, error: "A QR PNG data URL under 350KB or Firebase Storage URL is required" });
    return;
  }
  if (!validStorageUrl) {
    res.status(400).json({ ok: false, error: "QR storage URL is not an approved Firebase Storage URL" });
    return;
  }
  await db.update(projectsTable).set({
    qrDataUrl: qrDataUrl.startsWith("data:image/") ? qrDataUrl : project.qrDataUrl,
    qrStorageUrl: qrStorageUrl || project.qrStorageUrl,
    qrGeneratedAt: project.qrGeneratedAt ?? new Date(),
    updatedAt: new Date(),
  })
    .where(eq(projectsTable.id, project.id));
  res.json({ ok: true, qrDataUrl: qrDataUrl.startsWith("data:image/") ? qrDataUrl : project.qrDataUrl, qrStorageUrl: qrStorageUrl || project.qrStorageUrl });
});

router.get("/compliance/teacher-projects", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can view the project verification queue" });
    return;
  }
  const rows = await db.select().from(projectsTable).orderBy(desc(projectsTable.updatedAt));
  res.json({
    ok: true,
    projects: rows.filter((project) =>
      canSeeProject(caller, project) &&
      [project.milestone1Status, project.milestone2Status, project.finalStatus].some((status) => status === "pending"),
    ),
  });
});

router.get("/compliance/duplicate-alerts", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "school" && caller.role !== "superadmin") {
    res.status(403).json({ ok: false, error: "Only school administrators can view duplicate alerts" });
    return;
  }
  const rows = await db.select().from(projectsTable)
    .where(eq(projectsTable.similarityFlag, true))
    .orderBy(desc(projectsTable.updatedAt));
  const visible = rows.filter((project) => canSeeProject(caller, project));
  res.json({ ok: true, projects: visible });
});

router.patch("/compliance/projects/:id/clear-flag", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "school" && caller.role !== "superadmin") {
    res.status(403).json({ ok: false, error: "Only school administrators can clear flags" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || !canSeeProject(caller, project)) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  await db.update(projectsTable).set({
    similarityFlag: false,
    similarityReason: String(req.body?.reason ?? "Reviewed by administrator").trim().slice(0, 500),
    clearedBy: caller.uid,
    clearedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(projectsTable.id, project.id));
  res.json({ ok: true });
});

router.get("/compliance/repeat-title-log", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "school" && caller.role !== "superadmin") {
    res.status(403).json({ ok: false, error: "Only school administrators can view repeat-title logs" });
    return;
  }
  const rows = await db.select().from(projectsTable).orderBy(desc(projectsTable.createdAt));
  res.json({
    ok: true,
    projects: rows.filter((project) =>
      project.previousTitleMatch && canSeeProject(caller, project),
    ),
  });
});

router.get("/compliance/superadmin-overview", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "superadmin") {
    res.status(403).json({ ok: false, error: "Only super administrators can view this dashboard" });
    return;
  }
  const projects = await db.select().from(projectsTable).orderBy(desc(projectsTable.createdAt));
  const records = await db.select().from(caRecordsTable);
  const schools = new Map<string, { projects: number; flagged: number; completed: number }>();
  for (const project of projects) {
    const current = schools.get(project.schoolId) ?? { projects: 0, flagged: 0, completed: 0 };
    current.projects += 1;
    if (project.similarityFlag) current.flagged += 1;
    if (project.finalStatus === "approved") current.completed += 1;
    schools.set(project.schoolId, current);
  }
  res.json({
    ok: true,
    projects,
    records,
    summary: {
      totalProjects: projects.length,
      flaggedProjects: projects.filter((project) => project.similarityFlag).length,
      pendingReviews: projects.filter((project) =>
        [project.milestone1Status, project.milestone2Status, project.finalStatus].includes("pending"),
      ).length,
      completedProjects: projects.filter((project) => project.finalStatus === "approved").length,
      schools: [...schools.entries()].map(([schoolId, values]) => ({ schoolId, ...values })),
    },
  });
});

router.get("/compliance/retooling", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const teacherId = caller.role === "teacher" ? caller.uid : String(req.query.teacherId ?? "");
  if (!teacherId) {
    res.status(400).json({ ok: false, error: "teacherId is required" });
    return;
  }
  const progress = await db
    .select()
    .from(teacherRetoolingProgressTable)
    .where(eq(teacherRetoolingProgressTable.teacherId, teacherId));
  res.json({ ok: true, progress });
});

router.get("/compliance/ca-records", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const learnerId = caller.role === "individual" || caller.role === "student"
    ? caller.uid
    : String(req.query.learnerId ?? "");
  let rows = learnerId
    ? await db.select().from(caRecordsTable).where(eq(caRecordsTable.learnerId, learnerId))
    : caller.role === "superadmin"
      ? await db.select().from(caRecordsTable)
      : caller.role === "school" && caller.schoolId
        ? await db.select().from(caRecordsTable).where(eq(caRecordsTable.schoolId, caller.schoolId))
      : [];
  const term = String(req.query.term ?? "").trim();
  if (term) rows = rows.filter((row) => row.term === term);
  res.json({ ok: true, records: rows });
});

router.get("/compliance/school-overview", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "school" || !caller.schoolId) {
    res.status(403).json({ ok: false, error: "Only school administrators can view this dashboard" });
    return;
  }
  const [allRecords, allProjects, retooling] = await Promise.all([
    db.select().from(caRecordsTable).where(eq(caRecordsTable.schoolId, caller.schoolId)),
    db.select().from(projectsTable).where(eq(projectsTable.schoolId, caller.schoolId)).orderBy(desc(projectsTable.createdAt)),
    db.select().from(teacherRetoolingProgressTable).where(eq(teacherRetoolingProgressTable.schoolId, caller.schoolId)),
  ]);
  const className = String(req.query.className ?? "").trim();
  const term = String(req.query.term ?? "").trim();
  const subject = String(req.query.subject ?? "").trim();
  const projects = allProjects.filter((project) =>
    (!className || project.className === className) &&
    (!subject || project.subject === subject),
  );
  const learnerIdsForClass = className
    ? new Set(projects.map((project) => project.learnerId))
    : null;
  const records = allRecords.filter((record) =>
    (!term || record.term === term) &&
    (!subject || record.subject === subject) &&
    (!learnerIdsForClass || learnerIdsForClass.has(record.learnerId)),
  ).map((record) => ({
    ...record,
    className: allProjects.find((project) => project.learnerId === record.learnerId)?.className ?? "",
  }));
  const teacherIds = [...new Set(retooling.map((row) => row.teacherId))];
  const completedTeachers = new Set(
    retooling.filter((row) => row.completed).map((row) => row.teacherId),
  );
  res.json({
    ok: true,
    records,
    projects,
    retooling,
    teachers: teacherIds.map((id) => ({ id, retooled: completedTeachers.has(id) })),
    cbcLessons: records.length,
  });
});

router.get("/compliance/uneb-items", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const rows = await db.select().from(unebItemsTable).limit(50);
  res.json({ ok: true, items: rows });
});

router.post("/compliance/retooling", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can update course progress" });
    return;
  }
  const moduleNumber = Number(req.body?.moduleId);
  if (!Number.isInteger(moduleNumber) || moduleNumber < 1 || moduleNumber > 10) {
    res.status(400).json({ ok: false, error: "moduleId must be an integer from 1 to 10" });
    return;
  }
  const moduleId = String(moduleNumber);
  const values = {
    completed: Boolean(req.body?.completed),
    quizScore: Number.isFinite(Number(req.body?.quizScore)) ? Number(req.body.quizScore) : null,
    certificateIssued: Boolean(req.body?.certificateIssued),
    practicalUploadPath: typeof req.body?.practicalUploadPath === "string" ? req.body.practicalUploadPath : null,
    completedAt: req.body?.completed ? new Date() : null,
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select()
    .from(teacherRetoolingProgressTable)
    .where(and(eq(teacherRetoolingProgressTable.teacherId, caller.uid), eq(teacherRetoolingProgressTable.moduleId, moduleId)));
  if (existing) {
    await db.update(teacherRetoolingProgressTable).set(values).where(eq(teacherRetoolingProgressTable.id, existing.id));
  } else {
    await db.insert(teacherRetoolingProgressTable).values({
      id: randomUUID(),
      teacherId: caller.uid,
      schoolId: caller.schoolId,
      moduleId,
      ...values,
    });
  }
  res.json({ ok: true });
});

router.post("/compliance/lesson-plan", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can generate lesson plans" });
    return;
  }
  const { subject, classLevel, topic, duration } = req.body as Record<string, string | undefined>;
  if (!subject || !classLevel || !topic || !duration) {
    res.status(400).json({ ok: false, error: "subject, classLevel, topic and duration are required" });
    return;
  }
  try {
    const content = await generateWithGemini(
      `You are a Ugandan CBC expert. Generate a printable NCDC-format lesson plan in clear plain text.
Subject: ${subject}
Class: ${classLevel}
Topic: ${topic}
Duration: ${duration}
Include learning outcomes, competency, values, generic skills, prior knowledge, materials, teacher activities, learner activities, assessment and reflection. Do not invent a page citation.`,
    );
    res.json({ ok: true, content });
  } catch (error) {
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "AI generation failed" });
  }
});

router.post("/compliance/curriculum-activity", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can generate curriculum activities" });
    return;
  }
  const topic = String(req.body?.topic ?? "").trim();
  const subject = String(req.body?.subject ?? "").trim();
  const classLevel = String(req.body?.classLevel ?? "").trim();
  const syllabusRef = String(req.body?.syllabusRef ?? "").trim();
  if (!topic || !subject || !classLevel) {
    res.status(400).json({ ok: false, error: "topic, subject and classLevel are required" });
    return;
  }
  const values = Array.isArray(req.body?.values) ? req.body.values.map(String).join(", ") : "";
  const skills = Array.isArray(req.body?.genericSkills) ? req.body.genericSkills.map(String).join(", ") : "";
  const competencies = Array.isArray(req.body?.competencies) ? req.body.competencies.map(String).join(", ") : "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const content = await generateWithGemini(
      `You are a Ugandan CBC expert. Topic: ${topic}.
Subject: ${subject}. Class: ${classLevel}.
Syllabus reference: ${syllabusRef || "Not supplied"}.
Known competencies: ${competencies || "Use the topic's appropriate CBC competencies"}.
Known generic skills: ${skills || "communication, collaboration, critical thinking and problem solving"}.
Known values: ${values || "responsibility, cooperation and respect"}.
Generate a CBC activity with:
- A real-life Ugandan scenario
- 2-3 CBC values to demonstrate
- Generic skills practiced
- Assessment criteria (Exceeds/Meets/Approaching/Needs Support)
- Time: 40 minutes
Use only NCDC competency-based materials for Lower Secondary and New A-Level 2025. Cite NCDC page references only when supplied above; do not invent citations.
Format: markdown with clear headings.`,
      controller.signal,
    );
    res.json({ ok: true, content });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "AI generation timed out"
      : error instanceof Error ? error.message : "AI generation failed";
    res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
});

router.get("/compliance/curriculum-links", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const q = String(req.query.q ?? "").trim();
  const rows = q
    ? await db.select().from(curriculumLinksTable).where(ilike(curriculumLinksTable.topic, `%${q}%`)).limit(50)
    : await db.select().from(curriculumLinksTable).limit(50);
  res.json({ ok: true, links: rows });
});

router.post("/compliance/triangulation", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can submit assessments" });
    return;
  }
  const { learnerId, schoolId, subject, competency, term } = req.body as Record<string, string | undefined>;
  if (!learnerId || !schoolId || !subject || !competency || !term) {
    res.status(400).json({ ok: false, error: "learnerId, schoolId, subject, competency and term are required" });
    return;
  }
  const quiz = Math.max(0, Math.min(100, Number(req.body?.evidence1 ?? 0)));
  const observed = Boolean(req.body?.evidence2);
  const project = Boolean(req.body?.evidence3);
  const points = (quiz >= 80 ? 2 : quiz >= 50 ? 1 : 0) + (observed ? 1 : 0) + (project ? 1 : 0);
  const finalLevel = points >= 4 ? "Exceeds" : points >= 3 ? "Meets" : points >= 1 ? "Approaching" : "Needs Support";
  const record = {
    id: randomUUID(),
    learnerId,
    schoolId,
    subject,
    competency,
    evidence1: String(quiz),
    evidence2: observed ? "Observed" : "Not observed",
    evidence3: project ? "Project evidence" : "No project evidence",
    finalLevel,
    term,
    teacherId: caller.uid,
  };
  await db.insert(caRecordsTable).values(record);
  res.status(201).json({ ok: true, record });
});

export default router;