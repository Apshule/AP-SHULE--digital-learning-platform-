import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleDomainRoute } from "./domain-routes";
import { handleEducationFileRoute } from "./education-files";
import type { EducationFileEnv } from "./education-files";
import type { AuthEnv, AuthUser } from "./backend-types";

function educationDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE role_capabilities (role TEXT, sector TEXT, capability TEXT, scope TEXT);
    CREATE TABLE sector_records (
      id TEXT PRIMARY KEY, sector TEXT, institution_id TEXT, school_id TEXT, owner_uid TEXT,
      record_type TEXT, record_json TEXT, created_by TEXT, is_deleted INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE firestore_documents (
      document_path TEXT, data_json TEXT, create_time TEXT, update_time TEXT, collection_path TEXT
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, institution_id TEXT, school_id TEXT, payer_id TEXT, amount INTEGER,
      currency TEXT, status TEXT, provider TEXT, provider_reference TEXT, idempotency_key TEXT,
      metadata_json TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY, email TEXT, role TEXT, active INTEGER DEFAULT 1, disabled INTEGER DEFAULT 0
    );
    CREATE TABLE audit (
      id TEXT PRIMARY KEY, institution_id TEXT, school_id TEXT, actor_id TEXT, action TEXT,
      resource_type TEXT, resource_id TEXT, metadata_json TEXT, created_at TEXT
    );
  `);
  db.exec(readFileSync(new URL("./migrations/0002_skills.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./migrations/0014_education_student_teacher.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./migrations/0016_shared_admissions_marks.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./migrations/0017_separate_school_and_skills_data.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./migrations/0020_education_native_workspace.sql", import.meta.url), "utf8"));
  return db;
}

function educationEnv(db: DatabaseSync): AuthEnv {
  const DB = {
    prepare(sql: string) {
      return {
        all: async <T extends Record<string, unknown>>() => ({ results: db.prepare(sql).all() as T[] }),
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          const statement = db.prepare(sql);
          return {
            all: async <T extends Record<string, unknown>>() => ({ results: statement.all(...params) as T[] }),
            run: async () => statement.run(...params),
          };
        },
      };
    },
  };
  const PG = {
    async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
      const normalizedSql = sql
        .replace(/\bpublic\./g, "")
        .replace(/\bIS NOT DISTINCT FROM\b/gi, "IS")
        .replace(/::(?:jsonb|json|date|timestamp|timestamptz|integer|int|numeric|text)\b/gi, "")
        .replace(/([A-Za-z_][A-Za-z0-9_.]*)\s*->>\s*'([^']+)'/g, (_match, column: string, key: string) =>
          `json_extract(${column}, '$.${key}')`,
        )
        .replace(/\$(\d+)\b/g, "?$1")
        .trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(normalizedSql)) {
        db.exec(normalizedSql);
        return { rows: [] as T[], rowCount: 0 };
      }
      const statement = db.prepare(normalizedSql);
      const params = values as (string | number | null)[];
      if (/^(SELECT|WITH)\b/i.test(normalizedSql) || /\bRETURNING\b/i.test(normalizedSql)) {
        const rows = (statement.all(...params) as T[]).map((row) => ({
          ...row,
          ...(typeof row.active === "number" ? { active: row.active !== 0 } : {}),
          ...(typeof row.disabled === "number" ? { disabled: row.disabled !== 0 } : {}),
        }));
        return { rows, rowCount: rows.length };
      }
      const result = statement.run(...params);
      return { rows: [] as T[], rowCount: Number(result.changes) };
    },
  };
  return { DB, PG } as unknown as AuthEnv;
}

function user(uid: string, role: string, email: string): AuthUser {
  return {
    uid, email, displayName: uid, role, institutionId: "school-org", schoolId: "school-1", sessionVersion: 1,
  } as AuthUser;
}

function unscopedUser(uid: string, role: string, email: string): AuthUser {
  return { ...user(uid, role, email), institutionId: null, schoolId: null };
}

function addRecord(
  db: DatabaseSync,
  id: string,
  recordType: string,
  record: Record<string, unknown>,
  ownerUid: string | null = null,
  schoolId: string | null = "school-1",
  institutionId: string | null = "school-org",
) {
  db.prepare(
    `INSERT INTO sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?, 'education', ?, ?, ?, ?, ?, 'school-admin', 0, 't', 't')`,
  ).run(id, institutionId, schoolId, ownerUid, recordType, JSON.stringify({ id, ...record }));
}

function addSharedMark(
  db: DatabaseSync,
  id: string,
  schoolId: string,
  institutionId: string,
  record: Record<string, unknown>,
) {
  db.prepare(
    `INSERT INTO marks (id,institution_id,school_id,learner_id,class_name,subject,score,record_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, institutionId, schoolId, record.learnerId || "", record.className || "",
    record.subject || "", record.score ?? null, JSON.stringify(record), "t", "t",
  );
}

function addLegacyRecord(db: DatabaseSync, collection: string, id: string, record: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO firestore_documents (document_path,data_json,create_time,update_time,collection_path) VALUES (?,?,?,?,?)",
  ).run(`${collection}/${id}`, JSON.stringify(record), "t", "t", collection);
}

function addAccount(db: DatabaseSync, uid: string, email: string, role: string) {
  db.prepare("INSERT INTO users (uid,email,role,active,disabled) VALUES (?,?,?,1,0)").run(uid, email, role);
}

function addLesson(
  db: DatabaseSync,
  id: string,
  schoolId: string,
  institutionId: string,
  ownerUid: string,
  className: string,
  subject: string,
  published = 1,
) {
  db.prepare(
    `INSERT INTO education_lessons
      (id,institution_id,school_id,owner_uid,title,description,class_name,subject,youtube_url,published,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, institutionId, schoolId, ownerUid, `Lesson ${id}`, "", className, subject, "", published, "t", "t");
}

function addParentLink(
  db: DatabaseSync,
  id: string,
  parentUid: string,
  learnerId: string,
  schoolId: string,
  institutionId: string,
  active = 1,
) {
  db.prepare(
    `INSERT INTO parent_links
      (id,institution_id,school_id,parent_uid,learner_id,relationship,active,created_by,created_at)
     VALUES (?,?,?,?,?,'parent',?,'school-admin','t')`,
  ).run(id, institutionId, schoolId, parentUid, learnerId, active);
}

function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: ArrayBuffer) => { objects.set(key, new Uint8Array(value)); },
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { body: new Response(value.slice()).body! } : null;
      },
      delete: async (key: string) => { objects.delete(key); },
    },
  };
}

function addStoredFile(
  db: DatabaseSync,
  objects: Map<string, Uint8Array>,
  lessonId: string,
  fileId: string,
  key: string,
  schoolId: string,
  institutionId: string,
  content = "%PDF-1.4\nstored test pdf",
) {
  db.prepare(
    `INSERT INTO education_files
      (id,lesson_id,institution_id,school_id,object_key,filename,content_type,size_bytes,sha256,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(fileId, lessonId, institutionId, schoolId, key, "lesson.pdf", "application/pdf", content.length, "test-sha", "teacher-1", "t");
  objects.set(key, new TextEncoder().encode(content));
}

const request = (path: string, method = "GET", body?: object) => new Request(`https://apshule.test${path}`, {
  method,
  body: body ? JSON.stringify(body) : undefined,
  headers: { "content-type": "application/json" },
});

describe("Education student and teacher workspaces", () => {
  it("stores school admissions and marks separately from vocational Skills records", async () => {
    const db = educationDatabase();
    try {
      db.prepare(
        `INSERT INTO vocational_enrollments (id,provider_id,course_id,full_name,created_at,updated_at)
         VALUES ('voc-admission','provider-1','course-1','Vocational learner','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO vocational_marks (id,provider_id,theory,practical,total,grade,created_at,updated_at)
         VALUES ('voc-mark','provider-1',40,40,80,'Fail','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO school_admissions (id,institution_id,school_id,record_json,is_deleted,created_at,updated_at)
         VALUES ('admissions/deleted-school','school-org','school-1','{}',1,'t','t')`,
      ).run();
      addLegacyRecord(db, "admissions", "legacy-vocational", {
        type: "vocational", institutionId: "school-org", fullName: "Vocational legacy row",
      });
      addLegacyRecord(db, "admissions", "legacy-ambiguous", {
        institutionId: "school-org", fullName: "Ambiguous legacy row",
      });
      addLegacyRecord(db, "admissions", "legacy-school", {
        type: "school", institutionId: "school-org", fullName: "School legacy row",
      });
      addLegacyRecord(db, "admissions", "deleted-school", {
        type: "school", institutionId: "school-org", fullName: "Deleted legacy copy",
      });
      addLegacyRecord(db, "school_admissions", "school-specific", {
        schoolId: "school-1", fullName: "School-specific legacy row",
      });
      addLegacyRecord(db, "school_admissions", "school-vocational", {
        type: "vocational", schoolId: "school-1", fullName: "Vocational school-collection row",
      });
      addLegacyRecord(db, "school_marks", "legacy-voc-mark", {
        type: "vocational", schoolId: "school-1", total: 80,
      });
      addLegacyRecord(db, "school_marks", "legacy-school-mark", {
        schoolId: "school-1", subject: "Mathematics", total: 85,
      });
      const env = educationEnv(db);
      const admin = user("admin-1", "superadmin", "admin@school.test");

      const admission = await handleDomainRoute(request("/api/school/admissions", "POST", {
        fullName: "School learner", studentId: "S-001", email: "learner@school.test",
      }), env, admin);
      expect(admission?.status).toBe(201);
      const admissionData = await admission!.json() as { record: Record<string, unknown> };
      const admissionId = String(admissionData.record.id);

      const mark = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        admissionId, studentId: "S-001", theory: 70, practical: 60, total: 130, grade: "Credit",
      }), env, admin);
      expect(mark?.status).toBe(201);
      const markData = await mark!.json() as { record: Record<string, unknown> };
      const markId = String(markData.record.id);

      const admissions = await handleDomainRoute(request("/api/school/admissions"), env, admin);
      const admissionRows = await admissions!.json() as { records: Array<Record<string, unknown>> };
      expect(admissionRows.records.map((row) => row.id)).toContain(admissionId);
      expect(admissionRows.records.map((row) => row.id)).not.toContain("voc-admission");
      expect(admissionRows.records.map((row) => row.id)).toContain("admissions/legacy-school");
      expect(admissionRows.records.map((row) => row.id)).not.toContain("admissions/deleted-school");
      expect(admissionRows.records.map((row) => row.id)).toContain("school_admissions/school-specific");
      expect(admissionRows.records.map((row) => row.id)).not.toContain("admissions/legacy-vocational");
      expect(admissionRows.records.map((row) => row.id)).not.toContain("admissions/legacy-ambiguous");
      expect(admissionRows.records.map((row) => row.id)).not.toContain("school_admissions/school-vocational");

      const marks = await handleDomainRoute(request("/api/school/academic/marks"), env, admin);
      const markRows = await marks!.json() as { records: Array<Record<string, unknown>> };
      expect(markRows.records.map((row) => row.id)).not.toContain("voc-mark");
      expect(markRows.records.map((row) => row.id)).not.toContain("school_marks/legacy-voc-mark");
      expect(markRows.records.map((row) => row.id)).toContain("school_marks/legacy-school-mark");

      const edited = await handleDomainRoute(request(`/api/school/admissions/${admissionId}`, "PATCH", {
        fullName: "Edited school learner",
      }), env, admin);
      expect(edited?.status).toBe(200);
      const removed = await handleDomainRoute(request(`/api/school/academic/marks/${markId}`, "DELETE"), env, admin);
      expect(removed?.status).toBe(200);
      const stored = db.prepare("SELECT is_deleted FROM marks WHERE id=?").get(markId) as { is_deleted: number };
      expect(stored).toEqual({ is_deleted: 1 });
    } finally {
      db.close();
    }
  });

  it("limits student profile reads to the linked learner and returns only linked school records", async () => {
    const db = educationDatabase();
    try {
      addRecord(db, "learner-1", "learner", {
        name: "Student One", studentNumber: "S-001", studentEmail: "student.one@school.test", className: "P5",
      });
      addRecord(db, "learner-2", "learner", {
        name: "Student Two", studentNumber: "S-002", studentEmail: "student.two@school.test", className: "P6",
      });
      addRecord(db, "mark-1", "marks", { learnerId: "learner-1", subject: "Mathematics", score: 84 });
      addRecord(db, "mark-2", "marks", { learnerId: "learner-2", subject: "Mathematics", score: 96 });
      addRecord(db, "attendance-1", "attendance", { studentNumber: "S-001", status: "present" });
      addRecord(db, "fee-1", "fee", { learnerId: "learner-1", amount: 50000 });
      const env = educationEnv(db);
      const student = user("student-1", "student", "student.one@school.test");

      const workspace = await handleDomainRoute(request("/api/school/education-workspace"), env, student);
      expect(workspace?.status).toBe(200);
      const data = await workspace!.json() as Record<string, any>;
      expect(data.student?.id).toBe("learner-1");
      expect(data.marks.map((row: Record<string, unknown>) => row.id)).toEqual(["mark-1"]);
      expect(data.attendance.map((row: Record<string, unknown>) => row.id)).toEqual(["attendance-1"]);
      expect(data.fees.map((row: Record<string, unknown>) => row.id)).toEqual(["fee-1"]);

      const profiles = await handleDomainRoute(request("/api/school/learners"), env, student);
      expect(profiles?.status).toBe(200);
      const records = await profiles!.json() as { records: Array<Record<string, unknown>> };
      expect(records.records.map((row) => row.id)).toEqual(["learner-1"]);

      const forbidden = await handleDomainRoute(request("/api/school/bursar/payments"), env, student);
      expect(forbidden?.status).toBe(403);
    } finally {
      db.close();
    }
  });

  it("limits teacher rosters and mark writes to assigned class and subject", async () => {
    const db = educationDatabase();
    try {
      addRecord(db, "assignment-1", "teacher_assignment", {
        teacherUid: "teacher-1", className: "P5", subject: "Mathematics",
      });
      addRecord(db, "learner-1", "learner", {
        name: "Assigned learner", studentNumber: "S-001", className: "P5",
      });
      addRecord(db, "learner-2", "learner", {
        name: "Unassigned learner", studentNumber: "S-002", className: "P6",
      });
      const env = educationEnv(db);
      const teacher = user("teacher-1", "teacher", "teacher@school.test");

      const workspace = await handleDomainRoute(request("/api/school/education-workspace"), env, teacher);
      expect(workspace?.status).toBe(200);
      const data = await workspace!.json() as Record<string, any>;
      expect(data.students.map((row: Record<string, unknown>) => row.id)).toEqual(["learner-1"]);

      const accepted = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        learnerId: "S-001", className: "P5", subject: "Mathematics", score: 84,
      }), env, teacher);
      expect(accepted?.status).toBe(201);

      const wrongClass = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        learnerId: "S-001", className: "P6", subject: "Mathematics", score: 84,
      }), env, teacher);
      expect(wrongClass?.status).toBe(403);

      const wrongSubject = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        learnerId: "S-001", className: "P5", subject: "Science", score: 84,
      }), env, teacher);
      expect(wrongSubject?.status).toBe(403);

      const otherLearner = await handleDomainRoute(request("/api/school/attendance", "POST", {
        learnerId: "S-002", className: "P6", date: "2026-09-29", status: "present",
      }), env, teacher);
      expect(otherLearner?.status).toBe(403);
    } finally {
      db.close();
    }
  });

  it("reads legacy Education fields nested under the Firestore data object", async () => {
    const db = educationDatabase();
    try {
      addLegacyRecord(db, "school_teacher_assignments", "assignment-1", {
        teacherUid: "legacy-teacher", className: "P5", subject: "Mathematics",
        schoolId: "school-1", institutionId: "school-org",
      });
      addLegacyRecord(db, "students", "legacy-student", {
        name: "Legacy learner", studentNumber: "S-OLD", studentEmail: "legacy.student@school.test",
        className: "P5", schoolId: "school-1", institutionId: "school-org",
      });
      addLegacyRecord(db, "school_marks", "mark-1", {
        learnerId: "legacy-student", subject: "Mathematics", score: 77,
        schoolId: "school-1", institutionId: "school-org",
      });
      const env = educationEnv(db);

      const teacherWorkspace = await handleDomainRoute(
        request("/api/school/education-workspace"), env,
        user("legacy-teacher", "teacher", "legacy.teacher@school.test"),
      );
      const teacherData = await teacherWorkspace!.json() as Record<string, any>;
      expect(teacherData.teacherAssignments).toHaveLength(1);
      expect(teacherData.students.map((row: Record<string, unknown>) => row.id)).toEqual(["students/legacy-student"]);

      const studentWorkspace = await handleDomainRoute(
        request("/api/school/education-workspace"), env,
        user("legacy-student-user", "student", "legacy.student@school.test"),
      );
      const studentData = await studentWorkspace!.json() as Record<string, any>;
      expect(studentData.student.id).toBe("students/legacy-student");
      expect(studentData.marks.map((row: Record<string, unknown>) => row.id)).toEqual(["school_marks/mark-1"]);
    } finally {
      db.close();
    }
  });

  it("limits unscoped students and teachers to their own or assigned school records", async () => {
    const db = educationDatabase();
    try {
      addRecord(db, "learner-own", "learner", {
        name: "Student One", studentNumber: "S-001", studentEmail: "student.one@school.test", className: "P5",
      }, "student-1");
      addRecord(db, "learner-other", "learner", {
        name: "Student Two", studentNumber: "S-002", studentEmail: "student.two@school.test", className: "P5",
      }, "student-2", "school-2", "school-org");
      addRecord(db, "class-one", "class", { name: "P5" });
      addRecord(db, "class-other", "class", { name: "P5" }, null, "school-2", "school-org");
      addRecord(db, "subject-one", "subject", { name: "Mathematics" });
      addRecord(db, "subject-other", "subject", { name: "Mathematics" }, null, "school-2", "school-org");
      addRecord(db, "assignment-one", "teacher_assignment", {
        teacherUid: "teacher-1", className: "P5", subject: "Mathematics",
      });
      addRecord(db, "assignment-no-school", "teacher_assignment", {
        teacherUid: "teacher-2", className: "P5", subject: "Mathematics",
      }, null, null, "school-org");
      addSharedMark(db, "mark-own", "school-1", "school-org", {
        studentId: "student-1", learnerId: "learner-own", className: "P5", subject: "Mathematics", score: 84,
      });
      addSharedMark(db, "mark-other", "school-2", "school-org", {
        studentId: "student-2", learnerId: "learner-other", className: "P5", subject: "Mathematics", score: 96,
      });
      const env = educationEnv(db);

      const student = unscopedUser("student-1", "student", "student.one@school.test");
      const studentWorkspace = await handleDomainRoute(request("/api/school/education-workspace"), env, student);
      const studentData = await studentWorkspace!.json() as Record<string, any>;
      expect(studentWorkspace?.status).toBe(200);
      expect(studentData.student?.id).toBe("learner-own");
      expect(studentData.marks.map((row: Record<string, unknown>) => row.id)).toEqual(["mark-own"]);
      expect(studentData.classes.map((row: Record<string, unknown>) => row.id)).toEqual(["class-one"]);
      const studentWrite = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        learnerId: "learner-own", className: "P5", subject: "Mathematics", score: 90,
      }), env, student);
      expect(studentWrite?.status).toBe(403);

      const teacher = unscopedUser("teacher-1", "teacher", "teacher@school.test");
      const teacherWorkspace = await handleDomainRoute(request("/api/school/education-workspace"), env, teacher);
      const teacherData = await teacherWorkspace!.json() as Record<string, any>;
      expect(teacherWorkspace?.status).toBe(200);
      expect(teacherData.students.map((row: Record<string, unknown>) => row.id)).toEqual(["learner-own"]);
      expect(teacherData.classes.map((row: Record<string, unknown>) => row.id)).toEqual(["class-one"]);
      expect(teacherData.subjects.map((row: Record<string, unknown>) => row.id)).toEqual(["subject-one"]);
      expect(teacherData.marks.map((row: Record<string, unknown>) => row.id)).toEqual(["mark-own"]);
      const teacherWrite = await handleDomainRoute(request("/api/school/academic/marks", "POST", {
        learnerId: "learner-own", className: "P5", subject: "Mathematics", score: 91,
      }), env, teacher);
      expect(teacherWrite?.status).toBe(403);

      const noSchoolAssignmentTeacher = unscopedUser("teacher-2", "teacher", "teacher.two@school.test");
      const noSchoolAssignmentWorkspace = await handleDomainRoute(
        request("/api/school/education-workspace"), env, noSchoolAssignmentTeacher,
      );
      const noSchoolAssignmentData = await noSchoolAssignmentWorkspace!.json() as Record<string, any>;
      expect(noSchoolAssignmentData.students).toEqual([]);
      expect(noSchoolAssignmentData.classes).toEqual([]);
      expect(noSchoolAssignmentData.marks).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("allows unscoped school staff to read all schools but blocks their writes", async () => {
    const db = educationDatabase();
    try {
      db.prepare("INSERT INTO role_capabilities (role,sector,capability,scope) VALUES (?,?,?,?)")
        .run("secretary", "education", "admissions.manage", "tenant");
      db.prepare("INSERT INTO role_capabilities (role,sector,capability,scope) VALUES (?,?,?,?)")
        .run("bursar", "education", "payments.manage", "tenant");
      db.prepare("INSERT INTO role_capabilities (role,sector,capability,scope) VALUES (?,?,?,?)")
        .run("student", "payments", "payments.read", "tenant");
      db.prepare(
        `INSERT INTO school_admissions (id,institution_id,school_id,record_json,created_at,updated_at)
         VALUES ('admission-one','school-org','school-1','{}','t','t'),
                ('admission-two','school-org','school-2','{}','t','t')`,
      ).run();
      db.prepare(
        `INSERT INTO payments (id,institution_id,school_id,payer_id,amount,currency,status,created_at,updated_at)
         VALUES ('payment-one','school-org','school-1','student-1',50000,'UGX','pending','t','t'),
                ('payment-two','school-org','school-2','student-2',60000,'UGX','paid','t','t')`,
      ).run();
      const env = educationEnv(db);

      const student = unscopedUser("student-1", "student", "student.one@school.test");
      const ownPayments = await handleDomainRoute(request("/api/payments"), env, student);
      const ownPaymentData = await ownPayments!.json() as { payments: Array<Record<string, unknown>> };
      expect(ownPayments?.status).toBe(200);
      expect(ownPaymentData.payments.map((row) => row.id)).toEqual(["payment-one"]);

      const secretary = unscopedUser("secretary-1", "secretary", "secretary@school.test");
      const admissions = await handleDomainRoute(request("/api/school/admissions"), env, secretary);
      const admissionData = await admissions!.json() as { records: Array<Record<string, unknown>> };
      expect(admissions?.status).toBe(200);
      expect(admissionData.records.map((row) => row.id).sort()).toEqual(["admission-one", "admission-two"]);
      const secretaryWrite = await handleDomainRoute(request("/api/school/admissions", "POST", {
        fullName: "New student",
      }), env, secretary);
      expect(secretaryWrite?.status).toBe(403);

      const bursar = unscopedUser("bursar-1", "bursar", "bursar@school.test");
      const workspace = await handleDomainRoute(request("/api/school/education-workspace"), env, bursar);
      const workspaceData = await workspace!.json() as Record<string, any>;
      expect(workspace?.status).toBe(200);
      expect(workspaceData.finance.payments.map((row: Record<string, unknown>) => row.id).sort())
        .toEqual(["payment-one", "payment-two"]);
      const payments = await handleDomainRoute(request("/api/school/bursar/payments"), env, bursar);
      const paymentData = await payments!.json() as { payments: Array<Record<string, unknown>> };
      expect(payments?.status).toBe(200);
      expect(paymentData.payments.map((row) => row.id).sort()).toEqual(["payment-one", "payment-two"]);
      const bursarWrite = await handleDomainRoute(request("/api/school/bursar/payments", "POST", {
        amount: 20000, idempotencyKey: "unscoped-write",
      }), env, bursar);
      expect(bursarWrite?.status).toBe(403);
      const genericPaymentWrite = await handleDomainRoute(request("/api/pay", "POST", {
        amount: 20000, idempotencyKey: "unscoped-generic-write",
      }), env, bursar);
      expect(genericPaymentWrite?.status).toBe(403);
    } finally {
      db.close();
    }
  });

  it("preserves the original school scope when an unscoped superadmin edits a shared record", async () => {
    const db = educationDatabase();
    try {
      db.prepare(
        `INSERT INTO school_admissions (id,institution_id,school_id,record_json,created_at,updated_at)
         VALUES ('admission-preserve','school-org','school-1','{"fullName":"Before"}','t','t')`,
      ).run();
      const admin = unscopedUser("root", "superadmin", "admin@school.test");
      const response = await handleDomainRoute(request("/api/school/admissions/admission-preserve", "PATCH", {
        fullName: "After",
      }), educationEnv(db), admin);
      expect(response?.status).toBe(200);
      const row = db.prepare(
        "SELECT school_id,institution_id,record_json FROM school_admissions WHERE id='admission-preserve'",
      ).get() as { school_id: string; institution_id: string; record_json: string };
      expect(row.school_id).toBe("school-1");
      expect(row.institution_id).toBe("school-org");
      expect(JSON.parse(row.record_json).fullName).toBe("After");
    } finally {
      db.close();
    }
  });
});

describe("Education native lessons and parent links", () => {
  it("allows assigned teachers to create lessons without video and rejects non-YouTube URLs", async () => {
    const db = educationDatabase();
    try {
      addRecord(db, "assignment-teacher", "teacher_assignment", {
        teacherUid: "teacher-1", className: "P5", subject: "Mathematics",
      });
      const env = educationEnv(db);
      const teacher = user("teacher-1", "teacher", "teacher@school.test");

      const withoutVideo = await handleDomainRoute(request("/api/school/lessons", "POST", {
        title: "Fractions", className: "P5", subject: "Mathematics",
      }), env, teacher);
      expect(withoutVideo?.status).toBe(201);
      const saved = await withoutVideo!.json() as { lesson: Record<string, unknown> };
      expect(saved.lesson.youtubeUrl).toBe("");

      const invalidVideo = await handleDomainRoute(request("/api/school/lessons", "POST", {
        title: "Fractions", className: "P5", subject: "Mathematics", youtubeUrl: "http://example.com/video",
      }), env, teacher);
      expect(invalidVideo?.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("stores superadmin parent links in the learner school and rejects wrong-role or cross-school linking", async () => {
    const db = educationDatabase();
    try {
      addAccount(db, "parent-1", "parent@school.test", "parent");
      addAccount(db, "not-parent", "student@school.test", "student");
      addRecord(db, "learner-school-1", "learner", { name: "Malaika", className: "P5" }, "student-1", "school-1", "school-org");
      addRecord(db, "learner-school-2", "learner", { name: "Malaika", className: "P5" }, "student-2", "school-2", "school-org");
      const env = educationEnv(db);
      const superadmin = unscopedUser("root", "superadmin", "root@school.test");

      const created = await handleDomainRoute(request("/api/school/parent-links", "POST", {
        parentEmail: "parent@school.test", learnerId: "learner-school-1",
      }), env, superadmin);
      expect(created?.status).toBe(201);
      const stored = db.prepare("SELECT institution_id,school_id FROM parent_links WHERE learner_id='learner-school-1'").get() as {
        institution_id: string; school_id: string;
      };
      expect(stored).toEqual({ institution_id: "school-org", school_id: "school-1" });

      const secretary = user("secretary-1", "secretary", "secretary@school.test");
      const wrongRole = await handleDomainRoute(request("/api/school/parent-links", "POST", {
        parentEmail: "student@school.test", learnerId: "learner-school-1",
      }), env, secretary);
      expect(wrongRole?.status).toBe(400);
      const otherSchool = await handleDomainRoute(request("/api/school/parent-links", "POST", {
        parentEmail: "parent@school.test", learnerId: "learner-school-2",
      }), env, secretary);
      expect(otherSchool?.status).toBe(404);
    } finally {
      db.close();
    }
  });

  it("limits parent workspace records and lessons to the explicitly linked child school", async () => {
    const db = educationDatabase();
    try {
      addAccount(db, "parent-1", "parent@school.test", "parent");
      addRecord(db, "learner-linked", "learner", {
        uid: "student-linked", name: "Malaika", className: "P5", studentNumber: "SHARED-NO",
      }, "student-linked", "school-1", "school-org");
      addRecord(db, "learner-other-school", "learner", {
        uid: "student-other", name: "Malaika", className: "P5", studentNumber: "SHARED-NO",
      }, "student-other", "school-2", "school-org");
      addParentLink(db, "link-parent-child", "parent-1", "learner-linked", "school-1", "school-org");
      addSharedMark(db, "mark-linked", "school-1", "school-org", {
        studentId: "SHARED-NO", className: "P5", subject: "Mathematics", score: 84,
      });
      addSharedMark(db, "mark-other-school", "school-2", "school-org", {
        studentId: "SHARED-NO", className: "P5", subject: "Mathematics", score: 21,
      });
      addLesson(db, "lesson-linked", "school-1", "school-org", "teacher-1", "P5", "Mathematics");
      addLesson(db, "lesson-other-school", "school-2", "school-org", "teacher-2", "P5", "Mathematics");
      const r2 = memoryR2();
      addStoredFile(db, r2.objects, "lesson-linked", "file-linked", "lesson-files/linked.pdf", "school-1", "school-org");
      const env = { ...educationEnv(db), FILES: r2.bucket } as unknown as EducationFileEnv;
      const parent = unscopedUser("parent-1", "parent", "parent@school.test");

      const response = await handleDomainRoute(request("/api/school/education-workspace"), env, parent);
      expect(response?.status).toBe(200);
      const data = await response!.json() as { children: Array<Record<string, any>> };
      expect(data.children).toHaveLength(1);
      expect(data.children[0].id).toBe("learner-linked");
      expect(data.children[0].marks.map((row: Record<string, unknown>) => row.id)).toEqual(["mark-linked"]);
      expect(data.children[0].lessons.map((row: Record<string, unknown>) => row.id)).toEqual(["lesson-linked"]);
      expect(data.children[0].lessons[0].files[0]).toMatchObject({ id: "file-linked", filename: "lesson.pdf" });
      expect(data.children[0].lessons[0].files[0].object_key).toBeUndefined();

      const lessonList = await handleDomainRoute(request("/api/school/lessons"), env, parent);
      const lessonData = await lessonList!.json() as { lessons: Array<Record<string, unknown>> };
      expect(lessonData.lessons.map((row) => row.id)).toEqual(["lesson-linked"]);

      db.prepare("UPDATE parent_links SET active=0,revoked_at='now' WHERE id='link-parent-child'").run();
      const revoked = await handleDomainRoute(request("/api/school/education-workspace"), env, parent);
      const revokedData = await revoked!.json() as { children: Array<Record<string, unknown>> };
      expect(revokedData.children).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("Education lesson PDF storage authorization", () => {
  it("allows the linked parent and student only in the matching school, and denies revoked or unrelated accounts", async () => {
    const db = educationDatabase();
    try {
      addAccount(db, "parent-1", "parent@school.test", "parent");
      addRecord(db, "learner-file-owner", "learner", {
        uid: "student-1", name: "Amina", className: "P4",
      }, "student-1", "school-1", "school-org");
      addParentLink(db, "file-parent-link", "parent-1", "learner-file-owner", "school-1", "school-org");
      addLesson(db, "lesson-school-1", "school-1", "school-org", "teacher-1", "P4", "Science");
      addLesson(db, "lesson-school-2", "school-2", "school-org", "teacher-2", "P4", "Science");
      const r2 = memoryR2();
      addStoredFile(db, r2.objects, "lesson-school-1", "pdf-school-1", "lesson-files/s1.pdf", "school-1", "school-org");
      addStoredFile(db, r2.objects, "lesson-school-2", "pdf-school-2", "lesson-files/s2.pdf", "school-2", "school-org");
      const env = { ...educationEnv(db), FILES: r2.bucket } as unknown as EducationFileEnv;
      const filePath = (lessonId: string, fileId: string) =>
        `/api/school/lessons/${lessonId}/files/${fileId}`;

      const parent = unscopedUser("parent-1", "parent", "parent@school.test");
      const parentOwnFile = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-1", "pdf-school-1")}`),
        env, parent, filePath("lesson-school-1", "pdf-school-1"),
      );
      expect(parentOwnFile.status).toBe(200);
      expect(await parentOwnFile.text()).toContain("%PDF-1.4");

      const parentOtherSchool = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-2", "pdf-school-2")}`),
        env, parent, filePath("lesson-school-2", "pdf-school-2"),
      );
      expect(parentOtherSchool.status).toBe(403);
      const otherParent = unscopedUser("parent-unlinked", "parent", "other@school.test");
      const unlinked = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-1", "pdf-school-1")}`),
        env, otherParent, filePath("lesson-school-1", "pdf-school-1"),
      );
      expect(unlinked.status).toBe(403);

      const student = user("student-1", "student", "student@school.test");
      const studentOwnFile = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-1", "pdf-school-1")}`),
        env, student, filePath("lesson-school-1", "pdf-school-1"),
      );
      expect(studentOwnFile.status).toBe(200);
      const studentOtherSchool = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-2", "pdf-school-2")}`),
        env, student, filePath("lesson-school-2", "pdf-school-2"),
      );
      expect(studentOtherSchool.status).toBe(403);

      db.prepare("UPDATE parent_links SET active=0 WHERE id='file-parent-link'").run();
      const revokedParentFile = await handleEducationFileRoute(
        new Request(`https://apshule.test${filePath("lesson-school-1", "pdf-school-1")}`),
        env, parent, filePath("lesson-school-1", "pdf-school-1"),
      );
      expect(revokedParentFile.status).toBe(403);
    } finally {
      db.close();
    }
  });

  it("requires an assigned teacher and validates PDF origin, size, signature, and storage cleanup", async () => {
    const db = educationDatabase();
    try {
      addRecord(db, "assignment-teacher-files", "teacher_assignment", {
        teacherUid: "teacher-1", className: "P4", subject: "Science",
      });
      addLesson(db, "lesson-teacher", "school-1", "school-org", "teacher-1", "P4", "Science");
      addLesson(db, "lesson-wrong-subject", "school-1", "school-org", "teacher-1", "P4", "Mathematics");
      addLesson(db, "lesson-wrong-school", "school-2", "school-org", "teacher-1", "P4", "Science");
      const r2 = memoryR2();
      const env = { ...educationEnv(db), FILES: r2.bucket } as unknown as EducationFileEnv;
      const teacher = user("teacher-1", "teacher", "teacher@school.test");
      const upload = async (lessonId: string, file: File, origin = "https://apshule.test") => {
        const form = new FormData();
        form.append("file", file);
        const path = `/api/school/lessons/${lessonId}/files`;
        return handleEducationFileRoute(
          new Request(`https://apshule.test${path}`, { method: "POST", body: form, headers: { origin } }),
          env, teacher, path,
        );
      };

      const validFile = () => new File(["%PDF-1.4\nvalid"], "science.pdf", { type: "application/pdf" });
      expect((await upload("lesson-wrong-subject", validFile())).status).toBe(403);
      expect((await upload("lesson-wrong-school", validFile())).status).toBe(403);
      expect((await upload("lesson-teacher", validFile(), "https://evil.example")).status).toBe(403);
      expect((await upload("lesson-teacher", new File(["not pdf"], "bad.pdf", { type: "application/pdf" }))).status).toBe(415);
      const large = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" });
      expect((await upload("lesson-teacher", large)).status).toBe(413);

      const uploaded = await upload("lesson-teacher", validFile());
      expect(uploaded.status).toBe(201);
      const metadata = await uploaded.json() as { file: { id: string } };
      expect(r2.objects.size).toBe(1);
      const getPath = `/api/school/lessons/lesson-teacher/files/${metadata.file.id}`;
      const opened = await handleEducationFileRoute(new Request(`https://apshule.test${getPath}`), env, teacher, getPath);
      expect(opened.status).toBe(200);
      expect(await opened.text()).toContain("%PDF-1.4");

      db.exec(`CREATE TRIGGER reject_education_file_metadata
        BEFORE INSERT ON education_files BEGIN SELECT RAISE(FAIL, 'metadata unavailable'); END;`);
      const failedInsert = await upload("lesson-teacher", validFile());
      expect(failedInsert.status).toBe(502);
      expect(r2.objects.size).toBe(1);
      const savedKey = db.prepare("SELECT object_key FROM education_files WHERE id=?").get(metadata.file.id) as { object_key: string };
      expect(r2.objects.has(savedKey.object_key)).toBe(true);
    } finally {
      db.close();
    }
  });
});