import type { AuthEnv, AuthUser } from "./backend-types";
import { inNeonTransaction } from "./neon-db";

type Row = Record<string, unknown>;
type FarmRole = "farm_admin" | "farm_director" | "farm_manager" | "farm_worker" | "superadmin";
const roles = new Set<FarmRole>(["farm_admin", "farm_director", "farm_manager", "farm_worker", "superadmin"]);
const writeRoles = new Set(["farm_admin", "farm_manager", "superadmin"]);
const workerTypes = new Set(["attendance", "egg_collection", "feed_consumption"]);
const types: Record<string, string> = {
  animals: "animal", animal: "animal", movements: "animal_movement", movement: "animal_movement",
  attendance: "attendance", eggs: "egg_collection", egg_collections: "egg_collection",
  inventory: "inventory", produce: "produce", feed: "feed_consumption", "feed-consumption": "feed_consumption",
  feed_consumption: "feed_consumption",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown, max = 240) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const parse = async (request: Request): Promise<Row | null> => {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
  } catch { return null; }
};
const roleOf = (user: AuthUser) => clean(user.role, 80).toLowerCase();
const tenant = (user: AuthUser) => ({ institutionId: user.institutionId || null, schoolId: user.schoolId || null });
const same = (a: unknown, b: string) => clean(a, 160) === b;

function postgres(env: AuthEnv) {
  if (!env.PG) throw new Error("Neon PostgreSQL is unavailable for Farm workflows");
  return env.PG;
}

function recordData(value: unknown): Row {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Farm record contains invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Farm record JSON must be an object");
  }
  return parsed as Row;
}

function postgresErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function assigned(animal: Row, uid: string): boolean {
  if (same(animal.assignedWorkerUid, uid) || same(animal.workerUid, uid)) return true;
  return Array.isArray(animal.assignedWorkerUids) && animal.assignedWorkerUids.some((value) => same(value, uid));
}

async function records(env: AuthEnv, user: AuthUser, type: string): Promise<Row[]> {
  const db = postgres(env);
  const role = roleOf(user);
  const values: unknown[] = ["farm", type];
  let scopeSql = "TRUE";
  if (role !== "superadmin") {
    if (user.schoolId) {
      values.push(user.schoolId, user.institutionId || "");
      scopeSql = "(school_id = $3 OR (school_id IS NULL AND institution_id = $4))";
    } else {
      values.push(user.institutionId || "");
      scopeSql = "institution_id = $3";
    }
  }
  if (role === "farm_worker") {
    values.push(user.uid);
    scopeSql += ` AND owner_uid = $${values.length}`;
  }
  const result = await db.query<Row>(
    `SELECT id,record_json,record_type,created_at,updated_at,owner_uid,school_id,institution_id
     FROM public.sector_records
     WHERE sector=$1 AND record_type=$2 AND ${scopeSql} AND is_deleted=0
     ORDER BY updated_at DESC LIMIT 500`,
    values,
  );
  return result.rows.map((row) => {
    const data = recordData(row.record_json);
    return {
      id: row.id,
      ...data,
      recordType: row.record_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      schoolId: row.school_id ?? data.schoolId ?? data.school_id ?? null,
      institutionId: row.institution_id ?? data.institutionId ?? data.institution_id ?? null,
    };
  });
}

async function visibleRecords(env: AuthEnv, user: AuthUser, type: string) {
  // Farm records apply tenant and owner_uid scope in PostgreSQL. Animals are
  // staff-owned registry rows, so apply worker assignment filtering afterwards.
  let result = type === "animal" && roleOf(user) === "farm_worker"
    ? await tenantAnimals(env, user)
    : await records(env, user, type);
  if (roleOf(user) !== "farm_worker") return result;
  if (type === "animal") return result.filter((animal) => assigned(animal, user.uid));
  return result.filter((row) => same(row.workerUid || row.ownerUid || row.fedBy || row.recordedBy, user.uid));
}

async function tenantAnimals(env: AuthEnv, user: AuthUser): Promise<Row[]> {
  const institution = user.institutionId || "";
  const school = user.schoolId || "";
  const result = await postgres(env).query<Row>(
    `SELECT id,record_json,record_type,created_at,updated_at FROM public.sector_records
     WHERE sector='farm' AND record_type='animal' AND is_deleted=0
       AND institution_id=$1 AND (school_id IS NULL OR school_id=$2)
     ORDER BY updated_at DESC LIMIT 500`,
    [institution, school],
  );
  return result.rows.map((row) => ({
    id: row.id, ...recordData(row.record_json),
    recordType: row.record_type, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

async function feedInventory(env: AuthEnv, user: AuthUser): Promise<Row[]> {
  const result = await postgres(env).query<Row>(
    `SELECT id,record_json FROM public.sector_records
     WHERE sector='farm' AND record_type='inventory' AND is_deleted=0
       AND institution_id=$1 AND (school_id IS NULL OR school_id=$2)
     ORDER BY updated_at DESC LIMIT 500`,
    [user.institutionId || "", user.schoolId || ""],
  );
  return result.rows.flatMap((row) => {
    const record = recordData(row.record_json);
    const quantityInStock = Number(record.quantityInStock);
    if (!Number.isFinite(quantityInStock) || quantityInStock < 0) return [];
    return [{
      id: row.id,
      name: clean(record.name, 160),
      quantityInStock,
      unit: clean(record.unit, 40) || "unit",
    }];
  });
}

async function feedProtectionReady(env: AuthEnv): Promise<boolean> {
  if (!env.PG) return false;
  const result = await env.PG.query<Row>(
    `SELECT tgname
     FROM pg_catalog.pg_trigger
     WHERE tgrelid=to_regclass('public.sector_records')
       AND NOT tgisinternal
       AND tgname IN ('farm_feed_consumption_validate', 'farm_feed_consumption_deduct_stock')`,
  );
  return result.rows.length === 2;
}

async function save(env: AuthEnv, user: AuthUser, type: string, fields: Row, ownerUid: string | null = null) {
  const t = tenant(user);
  const recordId = clean(fields.id, 300) || id(type);
  const timestamp = new Date().toISOString();
  // Deliberately construct tenant fields here: browser-supplied tenant/owner IDs are ignored.
  const payload = { ...fields, id: recordId, recordType: type, institutionId: t.institutionId, schoolId: t.schoolId, updatedAt: timestamp };
  await postgres(env).query(
    `INSERT INTO public.sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10)`,
    [recordId, "farm", t.institutionId, t.schoolId, ownerUid, type, JSON.stringify(payload), user.uid, timestamp, timestamp],
  );
  return payload;
}

function allowedWrite(role: string, type: string): boolean {
  return writeRoles.has(role) || role === "farm_worker" && workerTypes.has(type);
}

function priorOperation(type: string, row: Row, input: Row): Response {
  const record: Row = { id: row.id, ...recordData(row.record_json) };
  if (type === "feed_consumption" &&
      (clean(record.itemId, 300) !== clean(input.itemId, 300) || Number(record.quantity) !== Number(input.quantity))) {
    return json({ ok: false, error: "operationId is already associated with a different feed entry" }, 409);
  }
  return json({ ok: true, idempotent: true, record });
}

async function findOperation(env: AuthEnv, user: AuthUser, type: string, operationId: string) {
  const schoolScope = type === "feed_consumption" ? " AND (school_id IS NULL OR school_id=$4)" : "";
  const values: unknown[] = [user.institutionId, type, operationId];
  if (type === "feed_consumption") values.push(user.schoolId || "");
  return postgres(env).query<Row>(
    `SELECT id,record_json FROM public.sector_records
     WHERE sector='farm' AND institution_id=$1 AND record_type=$2
       AND record_json::jsonb ->> 'operationId' = $3 AND is_deleted=0${schoolScope}
     LIMIT 1`,
    values,
  );
}

export async function handleFarmWorkflowRoute(request: Request, env: AuthEnv, user: AuthUser | null | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/farm/")) return null;
  if (!user) return json({ ok: false, error: "Authentication required" }, 401);
  const role = roleOf(user);
  if (!roles.has(role as FarmRole)) return json({ ok: false, error: "Farm access required" }, 403);
  if (!user.institutionId) return json({ ok: false, error: "A selected Farm institution is required" }, 403);
  const path = url.pathname.slice("/api/farm/".length).split("/").filter(Boolean);
  const area = path[0] || "";
  const type = types[area];
  if (area === "workspace" && request.method === "GET") {
    if (!env.PG) return json({ ok: false, error: "Neon PostgreSQL is unavailable for Farm workflows" }, 503);
    const result: Row = { ok: true, role, institutionId: user.institutionId || null, schoolId: user.schoolId || null };
    result.animals = await visibleRecords(env, user, "animal");
    result.movements = role === "farm_worker" ? [] : await visibleRecords(env, user, "animal_movement");
    result.attendance = await visibleRecords(env, user, "attendance");
    result.eggs = await visibleRecords(env, user, "egg_collection");
    result.produce = await visibleRecords(env, user, "produce");
    result.inventory = role === "farm_worker" ? [] : await visibleRecords(env, user, "inventory");
    result.feedEnabled = await feedProtectionReady(env);
    result.feedInventory = result.feedEnabled ? await feedInventory(env, user) : [];
    result.feed = await visibleRecords(env, user, "feed_consumption");
    return json(result);
  }
  if (area === "reports" && request.method === "GET") {
    if (role === "farm_worker") return json({ ok: false, error: "Farm reports are restricted to supervisors" }, 403);
    if (!env.PG) return json({ ok: false, error: "Neon PostgreSQL is unavailable for Farm workflows" }, 503);
    const [animals, movements, attendance, eggs, produce, feed] = await Promise.all([
      records(env, user, "animal"), records(env, user, "animal_movement"),
      records(env, user, "attendance"), records(env, user, "egg_collection"), records(env, user, "produce"),
      records(env, user, "feed_consumption"),
    ]);
    return json({
      ok: true, partial: true,
      summary: { animals: animals.length, movements: movements.length, attendance: attendance.length, eggCollections: eggs.length, produce: produce.length, feedEvents: feed.length },
      note: "Operational Farm report only; sales, expenses, cameras, and biometric data are not enabled in this slice.",
    });
  }
  if (!type || path.length > 2) return json({ ok: false, error: "Unknown Farm workflow route" }, 404);
  if (request.method === "GET") {
    if (role === "farm_worker" && !workerTypes.has(type)) {
      // Workers can see only animals assigned to them, and their own operational records.
      if (type !== "animal") return json({ ok: false, error: "Worker records are restricted to own operations" }, 403);
    }
    if (!env.PG) return json({ ok: false, error: "Neon PostgreSQL is unavailable for Farm workflows" }, 503);
    const result = await visibleRecords(env, user, type);
    return json({ ok: true, records: result });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Only POST append operations are supported" }, 405);
  if (!allowedWrite(role, type) || role === "farm_director") return json({ ok: false, error: "Farm role cannot mutate this workflow" }, 403);
  if (["animal", "inventory"].includes(type) && role !== "farm_admin" && role !== "superadmin") {
    return json({ ok: false, error: "Farm registry and inventory management is restricted to Farm Admin" }, 403);
  }
  if (!env.PG) return json({ ok: false, error: "Neon PostgreSQL is unavailable for Farm workflows" }, 503);
  const input = await parse(request);
  if (!input) return json({ ok: false, error: "A JSON Farm record is required" }, 400);
  const operationId = clean(input.operationId || input.idempotencyKey, 180);
  if (request.method === "POST" && !operationId && ["animal_movement", "attendance", "egg_collection", "feed_consumption"].includes(type)) {
    return json({ ok: false, error: "An operationId is required for idempotent Farm operations" }, 400);
  }
  let feedItemId = "";
  let feedQuantity = 0;
  let feedItem: Row | null = null;
  if (type === "feed_consumption") {
    feedItemId = clean(input.itemId, 300);
    const quantity = Number(input.quantity);
    const roundedQuantity = Math.round(quantity * 1000) / 1000;
    if (!feedItemId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000 ||
        Math.abs(quantity - roundedQuantity) > 0.000000001) {
      return json({ ok: false, error: "A feed item and positive quantity (up to three decimal places) are required" }, 400);
    }
    feedQuantity = roundedQuantity;
    input.itemId = feedItemId;
    input.quantity = feedQuantity;
    input.notes = clean(input.notes, 500);
    if (!(await feedProtectionReady(env))) {
      return json({ ok: false, error: "Feed recording is unavailable until Farm stock protection is enabled" }, 503);
    }
  }
  if (operationId) {
    const prior = await findOperation(env, user, type, operationId);
    if (prior.rows[0]) return priorOperation(type, prior.rows[0], input);
  }
  if (input.id) {
    const collision = await postgres(env).query<Row>(
      "SELECT id FROM public.sector_records WHERE id=$1 LIMIT 1",
      [clean(input.id, 300)],
    );
    if (collision.rows[0]) return json({ ok: false, error: "Record ID already exists; append operations cannot overwrite records" }, 409);
  }
  // Ownership is always derived from the authenticated principal; client owner IDs are never accepted.
  const owner = role === "farm_worker" ? user.uid : null;
  if (role === "farm_worker") {
    input.workerUid = user.uid; input.ownerUid = user.uid;
  }
  if (type === "animal") {
    const name = clean(input.name, 160);
    const animalType = clean(input.animalType, 80);
    const assignedWorkerUid = clean(input.assignedWorkerUid, 160);
    if (!name || !animalType) return json({ ok: false, error: "Animal name and type are required" }, 400);
    if (assignedWorkerUid) {
      const worker = await postgres(env).query<Row>(
        "SELECT uid FROM public.users WHERE uid=$1 AND lower(role)='farm_worker' AND institution_id=$2 AND active=TRUE AND disabled=FALSE LIMIT 1",
        [assignedWorkerUid, user.institutionId],
      );
      if (!worker.rows[0]) return json({ ok: false, error: "Assigned worker must be active in this farm tenant" }, 400);
    }
    input.name = name;
    input.animalType = animalType;
    input.assignedWorkerUid = assignedWorkerUid || null;
  }
  if (type === "inventory") {
    const name = clean(input.name, 160);
    const quantityInStock = Number(input.quantityInStock);
    if (!name || !Number.isFinite(quantityInStock) || quantityInStock < 0) {
      return json({ ok: false, error: "Inventory name and non-negative quantity are required" }, 400);
    }
    input.name = name;
    input.quantityInStock = quantityInStock;
    input.unit = clean(input.unit, 40) || "unit";
  }
  if (type === "produce") {
    const recordId = clean(input.id, 300);
    const name = clean(input.name || input.product, 160);
    const quantity = Number(input.quantity);
    const unit = clean(input.unit, 40) || "unit";
    const unitPrice = Number(input.unitPrice);
    const notes = clean(input.notes, 500);
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      return json({ ok: false, error: "Produce name and positive quantity (up to 1,000,000) are required" }, 400);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000_000) {
      return json({ ok: false, error: "Produce unit price must be a non-negative amount" }, 400);
    }
    for (const key of Object.keys(input)) delete input[key];
    if (recordId) input.id = recordId;
    if (operationId) input.operationId = operationId;
    input.name = name;
    input.quantity = Math.round(quantity * 1000) / 1000;
    input.unit = unit;
    input.unitPrice = Math.round(unitPrice * 100) / 100;
    input.notes = notes;
  }
  if (role === "farm_worker" && ["attendance", "egg_collection"].includes(type) && input.animalId) {
    const animal = (await tenantAnimals(env, user)).find((row) => same(row.id, clean(input.animalId, 300)));
    if (!animal || !assigned(animal, user.uid)) return json({ ok: false, error: "Animal is not assigned to this worker" }, 403);
  }
  if (type === "animal_movement") {
    const animalId = clean(input.animalId, 300);
    const movementType = clean(input.movementType, 80).toUpperCase();
    if (!movementType || !["IN", "OUT", "MOVE", "MOVED_IN", "MOVED_OUT"].includes(movementType)) {
      return json({ ok: false, error: "Movement type must be IN, OUT, or MOVE" }, 400);
    }
    const animal = (await tenantAnimals(env, user)).find((row) => same(row.id, animalId));
    if (!animal) return json({ ok: false, error: "Animal is not in this farm tenant" }, 403);
    const workerUid = role === "farm_worker" ? user.uid : clean(input.workerUid, 160);
    if (!workerUid || !assigned(animal, workerUid)) {
      return json({ ok: false, error: "Movement requires a worker assigned to that animal" }, 403);
    }
    input.workerUid = workerUid;
    input.animalId = animal.id;
    input.movementType = movementType;
  }
  if (type === "attendance") {
    const status = clean(input.status, 40).toLowerCase();
    if (!["present", "absent", "checkout"].includes(status)) {
      return json({ ok: false, error: "Attendance status must be present, absent, or checkout" }, 400);
    }
    input.status = status;
  }
  if (type === "egg_collection") {
    const totalEggs = Number(input.totalEggs);
    const goodEggs = Number(input.goodEggs);
    if (!Number.isInteger(totalEggs) || !Number.isInteger(goodEggs) || totalEggs < 0 || goodEggs < 0 || goodEggs > totalEggs) {
      return json({ ok: false, error: "Egg counts must be integers with 0 <= goodEggs <= totalEggs" }, 400);
    }
  }
  if (type === "feed_consumption") {
    const inventory = await postgres(env).query<Row>(
      `SELECT id,record_json FROM public.sector_records
       WHERE id=$1 AND sector='farm' AND record_type='inventory' AND is_deleted=0
         AND institution_id=$2 AND (school_id IS NULL OR school_id=$3)
       LIMIT 1`,
      [feedItemId, user.institutionId, user.schoolId || ""],
    );
    if (!inventory.rows[0]) return json({ ok: false, error: "Feed inventory item was not found in this Farm" }, 404);
    try {
      feedItem = recordData(inventory.rows[0].record_json);
    } catch {
      return json({ ok: false, error: "Feed inventory item is invalid" }, 409);
    }
    const available = Number(feedItem.quantityInStock);
    if (!Number.isFinite(available) || available < feedQuantity) {
      return json({ ok: false, error: "Not enough stock is available for this feed entry" }, 409);
    }
  }
  try {
    const fields: Row = type === "feed_consumption" && feedItem
      ? {
          itemId: feedItemId,
          itemName: clean(feedItem.name, 160),
          quantity: feedQuantity,
          unit: clean(feedItem.unit, 40) || "unit",
          notes: clean(input.notes, 500),
          recordedBy: user.uid,
          ...(role === "farm_worker" ? { workerUid: user.uid, ownerUid: user.uid } : {}),
        }
      : { ...input };
    const saveRecord = () => save(env, user, type, { ...fields, operationId: operationId || undefined }, owner);
    const saved = type === "feed_consumption"
      ? await inNeonTransaction(postgres(env), saveRecord)
      : await saveRecord();
    return json({ ok: true, record: saved }, 201);
  } catch (error) {
    const message = String(error);
    if (/FARM_STOCK_UNAVAILABLE/i.test(message)) {
      return json({ ok: false, error: "Not enough stock is available for this feed entry" }, 409);
    }
    if (/FARM_FEED_INVALID/i.test(message)) return json({ ok: false, error: "Feed entry is invalid" }, 400);
    if (postgresErrorCode(error) !== "23505" && !/Farm inventory cannot go below zero/i.test(message)) throw error;
    if (operationId) {
      const prior = await findOperation(env, user, type, operationId);
      if (prior.rows[0]) return priorOperation(type, prior.rows[0], input);
    }
    return json({ ok: false, error: "This record already exists or violates a Farm inventory guard" }, 409);
  }
}