import { Router, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { and, desc, eq, ilike } from "drizzle-orm";
import {
  caRecordsTable,
  curriculumLinksTable,
  db,
  projectsTable,
  teacherRetoolingProgressTable,
  unebItemsTable,
} from "@workspace/db";
import { randomUUID } from "node:crypto";

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
      schoolId: String(firestoreValue(document.fields, "schoolId") ?? "") || undefined,
      subject: String(firestoreValue(document.fields, "subject") ?? "") || undefined,
      classes,
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

async function generateWithGemini(prompt: string): Promise<string> {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured");
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" +
      `?key=${encodeURIComponent(GOOGLE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const visible = rows.filter((project) => canSeeProject(caller, project));
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
  };
  const title = String(body.title ?? "").trim();
  if (!title || !body.schoolId || !body.className || !body.subject) {
    res.status(400).json({ ok: false, error: "schoolId, className, subject and title are required" });
    return;
  }
  const previous = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.learnerId, caller.uid), eq(projectsTable.title, title)));
  if (previous.length) {
    res.status(409).json({ ok: false, error: "This project title has already been used" });
    return;
  }
  const id = randomUUID();
  const project = {
    id,
    learnerId: caller.uid,
    schoolId: body.schoolId,
    className: body.className,
    subject: body.subject,
    title,
    lin: `APSHULE-${body.schoolId}-${id.slice(0, 8).toUpperCase()}`,
    qrCode: `APSHULE-PROJECT-${id}`,
    previousTitleCheck: true,
  };
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
  const fields = {
    "1": { date: projectsTable.milestone1Date, photo: projectsTable.milestone1Photo, status: projectsTable.milestone1Status },
    "2": { date: projectsTable.milestone2Date, photo: projectsTable.milestone2Photo, status: projectsTable.milestone2Status },
    final: { date: projectsTable.finalDate, photo: projectsTable.finalPhoto, status: projectsTable.finalStatus },
  }[milestone];
  const photo = typeof req.body?.photo === "string" ? req.body.photo : "";
  if (!fields || !photo || photo.length > 700_000) {
    res.status(400).json({ ok: false, error: "Choose a milestone and a compressed photo under 500KB" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || project.learnerId !== caller.uid) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  await db
    .update(projectsTable)
    .set({ [fields.date.name]: new Date(), [fields.photo.name]: photo, [fields.status.name]: "pending" })
    .where(eq(projectsTable.id, project.id));
  res.json({ ok: true });
});

router.patch("/compliance/projects/:id/review", async (req, res) => {
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (caller.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teachers can review projects" });
    return;
  }
  const status = req.body?.status === "approved" ? "approved" : "rejected";
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project || !canSeeProject(caller, project)) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return;
  }
  await db
    .update(projectsTable)
    .set({ finalStatus: status, teacherObservedTick: Boolean(req.body?.observed) })
    .where(eq(projectsTable.id, project.id));
  if (status === "approved") {
    await db.insert(caRecordsTable).values({
      id: randomUUID(),
      learnerId: project.learnerId,
      schoolId: project.schoolId,
      subject: project.subject,
      competency: "Project work and communication",
      evidence1: "Project milestone evidence",
      evidence2: req.body?.observed ? "Teacher observed" : "Teacher review",
      evidence3: "Final project photo",
      finalLevel: "Meets",
      term: String(req.body?.term ?? "Current term"),
      teacherId: caller.uid,
    });
  }
  res.json({ ok: true });
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
  const rows = learnerId
    ? await db.select().from(caRecordsTable).where(eq(caRecordsTable.learnerId, learnerId))
    : caller.role === "superadmin"
      ? await db.select().from(caRecordsTable)
      : [];
  res.json({ ok: true, records: rows });
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
  const moduleId = String(req.body?.moduleId ?? "").trim();
  if (!moduleId) {
    res.status(400).json({ ok: false, error: "moduleId is required" });
    return;
  }
  const values = {
    completed: Boolean(req.body?.completed),
    quizScore: Number.isFinite(Number(req.body?.quizScore)) ? Number(req.body.quizScore) : null,
    certificateIssued: Boolean(req.body?.certificateIssued),
    practicalUploadPath: typeof req.body?.practicalUploadPath === "string" ? req.body.practicalUploadPath : null,
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