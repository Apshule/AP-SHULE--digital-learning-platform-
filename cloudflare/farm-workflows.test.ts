import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleFarmWorkflowRoute } from "./farm-workflows";
import type { AuthEnv, AuthUser } from "./backend-types";

const env = {} as AuthEnv;
const user = (role: string, institutionId = "farm-1") => ({ uid: "u1", email: "u", displayName: "U", role, institutionId, schoolId: null, sessionVersion: 1 }) as AuthUser;
const request = (path: string, method = "GET", body?: object) => new Request(`https://appshule.test${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });

describe("Farm workflow boundaries", () => {
  it("requires authentication and tenant scope", async () => {
    expect((await handleFarmWorkflowRoute(request("/api/farm/animals"), env, null))?.status).toBe(401);
    expect((await handleFarmWorkflowRoute(request("/api/farm/animals"), env, user("farm_admin", "")))?.status).toBe(403);
  });
  it("keeps directors read-only and workers scoped", async () => {
    expect((await handleFarmWorkflowRoute(request("/api/farm/animals", "POST", { name: "cow" }), env, user("farm_director")))?.status).toBe(403);
    expect((await handleFarmWorkflowRoute(request("/api/farm/inventory", "POST", { name: "feed", quantityInStock: 3 }), env, user("farm_worker")))?.status).toBe(403);
  });
  it("does not expose financial or biometric routes", async () => {
    expect((await handleFarmWorkflowRoute(request("/api/farm/sales"), env, user("farm_admin")))?.status).toBe(404);
    expect((await handleFarmWorkflowRoute(request("/api/farm/faceEmbedding"), env, user("farm_admin")))?.status).toBe(404);
  });
  it("validates registry, inventory, and idempotency inputs before writing", async () => {
    expect((await handleFarmWorkflowRoute(request("/api/farm/animals", "POST", { name: "", animalType: "" }), env, user("farm_admin")))?.status).toBe(400);
    expect((await handleFarmWorkflowRoute(request("/api/farm/inventory", "POST", { name: "feed", quantityInStock: -1 }), env, user("farm_admin")))?.status).toBe(400);
    expect((await handleFarmWorkflowRoute(request("/api/farm/attendance", "POST", { status: "present" }), env, user("farm_worker")))?.status).toBe(400);
  });

  it("installs the inventory floor and operation uniqueness guards", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE sector_records (
        id TEXT PRIMARY KEY, sector TEXT, institution_id TEXT, school_id TEXT, owner_uid TEXT,
        record_type TEXT, record_json TEXT, is_deleted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
      )`);
      db.exec(readFileSync(new URL("./migrations/0011_farm_workflow_guards.sql", import.meta.url), "utf8"));
      const insert = db.prepare("INSERT INTO sector_records (id,sector,institution_id,record_type,record_json,is_deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
      insert.run("stock-1", "farm", "farm-1", "inventory", JSON.stringify({ quantityInStock: 2 }), 0, "t", "t");
      expect(() => db.prepare("UPDATE sector_records SET record_json=? WHERE id='stock-1'")
        .run(JSON.stringify({ quantityInStock: -1 }))).toThrow();
      insert.run("egg-1", "farm", "farm-1", "egg_collection", JSON.stringify({ operationId: "op-1" }), 0, "t", "t");
      expect(() => insert.run("egg-2", "farm", "farm-1", "egg_collection", JSON.stringify({ operationId: "op-1" }), 0, "t", "t")).toThrow();
    } finally {
      db.close();
    }
  });
});