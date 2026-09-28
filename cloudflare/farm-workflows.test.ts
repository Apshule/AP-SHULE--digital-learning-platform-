import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleFarmWorkflowRoute } from "./farm-workflows";
import { handleDomainRoute } from "./domain-routes";
import type { AuthEnv, AuthUser } from "./backend-types";

const env = {} as AuthEnv;
const user = (role: string, institutionId = "farm-1") => ({ uid: "u1", email: "u", displayName: "U", role, institutionId, schoolId: null, sessionVersion: 1 }) as AuthUser;
const request = (path: string, method = "GET", body?: object) => new Request(`https://appshule.test${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });

function farmDatabase(includeFeedMigration = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sector_records (
    id TEXT PRIMARY KEY, sector TEXT, institution_id TEXT, school_id TEXT, owner_uid TEXT,
    record_type TEXT, record_json TEXT, created_by TEXT, is_deleted INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT
  )`);
  db.exec("CREATE TABLE firestore_documents (document_path TEXT, data_json TEXT, create_time TEXT, update_time TEXT, collection_path TEXT)");
  db.exec(readFileSync(new URL("./migrations/0011_farm_workflow_guards.sql", import.meta.url), "utf8"));
  if (includeFeedMigration) {
    db.exec(readFileSync(new URL("./migrations/0012_farm_feed_atomic.sql", import.meta.url), "utf8"));
  }
  return db;
}

function farmEnv(db: DatabaseSync): AuthEnv {
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

function addInventory(db: DatabaseSync, id: string, institutionId: string, schoolId: string | null, record: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?, 'farm', ?, ?, NULL, 'inventory', ?, 'u-admin', 0, 't', 't')`,
  ).run(id, institutionId, schoolId, JSON.stringify({ id, ...record }));
}

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
    const db = farmDatabase();
    try {
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

  it("atomically deducts only same-tenant feed stock and rolls back invalid or unavailable entries", () => {
    const db = farmDatabase();
    try {
      addInventory(db, "stock-1", "farm-1", null, { name: "Layer mash", quantityInStock: 2, unit: "kg" });
      addInventory(db, "other-farm-stock", "farm-2", null, { name: "Other farm feed", quantityInStock: 8, unit: "kg" });
      addInventory(db, "other-school-stock", "farm-1", "school-2", { name: "Other school feed", quantityInStock: 6, unit: "kg" });
      const insertFeed = db.prepare(
        `INSERT INTO sector_records
          (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
         VALUES (?, 'farm', ?, ?, NULL, 'feed_consumption', ?, 'u1', 0, 't', 't')`,
      );
      const event = (id: string, institutionId: string, itemId: string, quantity: number, operationId: string, schoolId: string | null = null) =>
        insertFeed.run(id, institutionId, schoolId, JSON.stringify({ itemId, quantity, operationId }));

      event("feed-1", "farm-1", "stock-1", 1.25, "feed-op-1");
      const stockAfterSuccess = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='stock-1'").get()?.record_json));
      expect(stockAfterSuccess.quantityInStock).toBe(0.75);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sector_records WHERE record_type='feed_consumption'").get()?.count).toBe(1);

      expect(() => event("feed-low", "farm-1", "stock-1", 1, "feed-op-low")).toThrow(/FARM_STOCK_UNAVAILABLE/);
      expect(() => event("feed-cross-tenant", "farm-1", "other-farm-stock", 1, "feed-op-cross")).toThrow(/FARM_STOCK_UNAVAILABLE/);
      expect(() => event("feed-cross-school", "farm-1", "other-school-stock", 1, "feed-op-school")).toThrow(/FARM_STOCK_UNAVAILABLE/);
      expect(() => event("feed-invalid", "farm-1", "stock-1", 0, "feed-op-invalid")).toThrow(/FARM_FEED_INVALID/);

      const stockAfterFailures = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='stock-1'").get()?.record_json));
      const otherFarmStock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='other-farm-stock'").get()?.record_json));
      const otherSchoolStock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='other-school-stock'").get()?.record_json));
      expect(stockAfterFailures.quantityInStock).toBe(0.75);
      expect(otherFarmStock.quantityInStock).toBe(8);
      expect(otherSchoolStock.quantityInStock).toBe(6);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sector_records WHERE record_type='feed_consumption'").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("records online feed use with idempotent retries and exposes only the worker's feed inventory summary", async () => {
    const db = farmDatabase();
    try {
      addInventory(db, "stock-1", "farm-1", null, {
        name: "Layer mash", quantityInStock: 3, unit: "kg", internalNote: "must not be exposed to workers",
      });
      addInventory(db, "school-stock", "farm-1", "school-2", { name: "Other school feed", quantityInStock: 4, unit: "kg" });
      const d1 = farmEnv(db);
      const body = { itemId: "stock-1", quantity: 0.5, operationId: "feed-op-1", notes: "Morning feed" };

      const firstResponse = await handleFarmWorkflowRoute(request("/api/farm/feed", "POST", body), d1, user("farm_worker"));
      expect(firstResponse?.status).toBe(201);
      const first = await firstResponse?.json() as { record: Record<string, unknown> };
      expect(first.record.itemName).toBe("Layer mash");
      expect(first.record.quantity).toBe(0.5);

      const duplicateResponse = await handleFarmWorkflowRoute(request("/api/farm/feed", "POST", body), d1, user("farm_worker"));
      expect(duplicateResponse?.status).toBe(200);
      expect((await duplicateResponse?.json() as { idempotent: boolean }).idempotent).toBe(true);

      const otherSchoolResponse = await handleFarmWorkflowRoute(
        request("/api/farm/feed", "POST", { itemId: "school-stock", quantity: 0.5, operationId: "feed-op-school" }),
        d1,
        user("farm_worker"),
      );
      expect(otherSchoolResponse?.status).toBe(404);

      const conflictResponse = await handleFarmWorkflowRoute(
        request("/api/farm/feed", "POST", { ...body, quantity: 0.75 }),
        d1,
        user("farm_worker"),
      );
      expect(conflictResponse?.status).toBe(409);

      const stock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='stock-1'").get()?.record_json));
      expect(stock.quantityInStock).toBe(2.5);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sector_records WHERE record_type='feed_consumption'").get()?.count).toBe(1);

      const workspaceResponse = await handleFarmWorkflowRoute(request("/api/farm/workspace"), d1, user("farm_worker"));
      const workspace = await workspaceResponse?.json() as {
        feedEnabled: boolean;
        inventory: Record<string, unknown>[];
        feedInventory: Record<string, unknown>[];
      };
      expect(workspace.feedEnabled).toBe(true);
      expect(workspace.inventory).toEqual([]);
      expect(workspace.feedInventory).toEqual([{ id: "stock-1", name: "Layer mash", quantityInStock: 2.5, unit: "kg" }]);
      expect(workspace.feedInventory[0]).not.toHaveProperty("internalNote");
    } finally {
      db.close();
    }
  });

  it("fails closed and hides feed stock when the atomic D1 triggers are missing", async () => {
    const db = farmDatabase(false);
    try {
      addInventory(db, "stock-1", "farm-1", null, { name: "Layer mash", quantityInStock: 3, unit: "kg" });
      const d1 = farmEnv(db);
      const unavailable = await handleFarmWorkflowRoute(
        request("/api/farm/feed", "POST", { itemId: "stock-1", quantity: 0.5, operationId: "feed-op-1" }),
        d1,
        user("farm_worker"),
      );
      expect(unavailable?.status).toBe(503);

      const workspaceResponse = await handleFarmWorkflowRoute(request("/api/farm/workspace"), d1, user("farm_worker"));
      const workspace = await workspaceResponse?.json() as {
        feedEnabled: boolean;
        feedInventory: Record<string, unknown>[];
      };
      expect(workspace.feedEnabled).toBe(false);
      expect(workspace.feedInventory).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sector_records WHERE record_type='feed_consumption'").get()?.count).toBe(0);
      const stock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id='stock-1'").get()?.record_json));
      expect(stock.quantityInStock).toBe(3);
    } finally {
      db.close();
    }
  });

  it("rejects malformed feed entries and generic feed writes", async () => {
    const malformed = await handleFarmWorkflowRoute(
      request("/api/farm/feed", "POST", { itemId: "stock-1", quantity: 0.0001, operationId: "bad-op" }),
      env,
      user("farm_admin"),
    );
    expect(malformed?.status).toBe(400);

    const missingKey = await handleFarmWorkflowRoute(
      request("/api/farm/feed", "POST", { itemId: "stock-1", quantity: 1 }),
      env,
      user("farm_admin"),
    );
    expect(missingKey?.status).toBe(400);

    const genericWrite = await handleDomainRoute(
      request("/api/farm/records", "POST", { recordType: "feed_consumption" }),
      env,
      user("farm_admin"),
    );
    expect(genericWrite?.status).toBe(405);
  });
});