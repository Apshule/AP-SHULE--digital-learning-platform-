import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleDomainRoute } from "./domain-routes";
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
    CREATE TABLE audit (
      id TEXT PRIMARY KEY, institution_id TEXT, school_id TEXT, actor_id TEXT, action TEXT,
      resource_type TEXT, resource_id TEXT, metadata_json TEXT, created_at TEXT
    );
  `);
  db.exec(readFileSync(new URL("./migrations/0014_education_student_teacher.sql", import.meta.url), "utf8"));
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
  return { DB } as unknown as AuthEnv;
}

function user(uid: string, role: string, email: string): AuthUser {
  return {
    uid, email, displayName: uid, role, institutionId: "school-org", schoolId: "school-1", sessionVersion: 1,
  } as AuthUser;
}

function addRecord(
  db: DatabaseSync,
  id: string,
  recordType: string,
  record: Record<string, unknown>,
  ownerUid: string | null = null,
) {
  db.prepare(
    `INSERT INTO sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?, 'education', 'school-org', 'school-1', ?, ?, ?, 'school-admin', 0, 't', 't')`,
  ).run(id, ownerUid, recordType, JSON.stringify({ id, ...record }));
}

function addLegacyRecord(db: DatabaseSync, collection: string, id: string, record: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO firestore_documents (document_path,data_json,create_time,update_time,collection_path) VALUES (?,?,?,?,?)",
  ).run(`${collection}/${id}`, JSON.stringify(record), "t", "t", collection);
}

const request = (path: string, method = "GET", body?: object) => new Request(`https://apshule.test${path}`, {
  method,
  body: body ? JSON.stringify(body) : undefined,
  headers: { "content-type": "application/json" },
});

describe("Education student and teacher workspaces", () => {
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
});