import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleClinicWorkflowRoute } from "./clinic-workflows";
import type { AuthEnv, AuthUser } from "./backend-types";

class LocalD1Statement {
  private values: unknown[] = [];

  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const results = this.db.prepare(this.sql).all(...this.values as never[]) as T[];
    return { results };
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...this.values as never[]);
    return { success: true };
  }
}

function createClinicDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE sector_records (
    id TEXT PRIMARY KEY NOT NULL,
    sector TEXT NOT NULL,
    institution_id TEXT NOT NULL,
    school_id TEXT,
    owner_uid TEXT,
    record_type TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE audit (
    id TEXT PRIMARY KEY NOT NULL,
    institution_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE firestore_documents (
    collection_path TEXT NOT NULL,
    document_path TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    create_time TEXT,
    update_time TEXT
  )`);
  db.exec(readFileSync(new URL("./migrations/0010_clinic_workflow_guards.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./migrations/0013_clinic_pharmacy_sales.sql", import.meta.url), "utf8"));
  return db;
}

function clinicEnv(db: DatabaseSync, beforeBatch?: () => void): AuthEnv {
  let beforeBatchCalled = false;
  const DB = {
    prepare(sql: string) {
      return new LocalD1Statement(db, sql);
    },
    async batch(statements: LocalD1Statement[]) {
      if (!beforeBatchCalled) {
        beforeBatch?.();
        beforeBatchCalled = true;
      }
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const PG = {
    async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
      const normalizedSql = sql.trim();
      const command = normalizedSql.toUpperCase();
      if (command === "BEGIN") {
        if (!beforeBatchCalled) {
          beforeBatch?.();
          beforeBatchCalled = true;
        }
        db.exec("BEGIN");
        return { rows: [] };
      }
      if (command === "COMMIT" || command === "ROLLBACK") {
        db.exec(command);
        return { rows: [] };
      }

      if (normalizedSql.includes("json_agg(json_build_object(")) {
        const institutionId = String(values[0] ?? "");
        const saleId = values[1] === undefined ? null : String(values[1]);
        const sales = db.prepare(
          `SELECT id, bill_record_id, patient_id, patient_name, total_amount, created_by, created_at
             FROM clinic_pharmacy_sales
            WHERE institution_id=? AND (? IS NULL OR id=?)
            ORDER BY created_at DESC
            LIMIT ?`,
        ).all(institutionId, saleId, saleId, saleId ? 1 : 100) as Array<Record<string, unknown>>;
        const rows = sales.map((sale) => {
          const bill = db.prepare(
            `SELECT record_json FROM sector_records
              WHERE id=? AND sector='clinic' AND institution_id=?
                AND record_type IN ('billing', 'clinic_billing') AND is_deleted=0`,
          ).get(sale.bill_record_id, institutionId) as { record_json?: string } | undefined;
          const billData = bill?.record_json ? JSON.parse(bill.record_json) as Record<string, unknown> : {};
          const items = db.prepare(
            `SELECT inventory_record_id, item_name, quantity, unit_price, line_total
               FROM clinic_pharmacy_sale_items
              WHERE sale_id=? AND institution_id=?
              ORDER BY item_name`,
          ).all(sale.id, institutionId) as Array<Record<string, unknown>>;
          const totalAmount = Number(sale.total_amount);
          return {
            id: sale.id,
            billId: sale.bill_record_id,
            patientId: sale.patient_id,
            patientName: sale.patient_name,
            totalAmount,
            createdBy: sale.created_by,
            createdAt: sale.created_at,
            invoiceNumber: billData.invoiceNumber ?? null,
            billStatus: billData.status ?? "missing",
            balanceRemaining: Number(billData.balanceRemaining ?? billData.totalAmount ?? totalAmount),
            items: items.map((item) => ({
              inventoryId: item.inventory_record_id,
              name: item.item_name,
              quantity: Number(item.quantity),
              unitPrice: Number(item.unit_price),
              lineTotal: Number(item.line_total),
            })),
          };
        });
        return { rows: rows as T[] };
      }

      if (/^UPDATE\s+sector_records\b/i.test(normalizedSql)
        && normalizedSql.includes("jsonb_build_object('unitPrice'")) {
        const [unitPrice, timestamp, recordId, institutionId] = values;
        const record = db.prepare(
          `SELECT record_json, record_type, is_deleted
             FROM sector_records
            WHERE id=? AND sector='clinic' AND institution_id=?`,
        ).get(recordId, institutionId) as {
          record_json?: string;
          record_type?: string;
          is_deleted?: number;
        } | undefined;
        if (!record || !["pharmacy_inventory", "clinic_pharmacy_inventory"].includes(String(record.record_type))
          || Number(record.is_deleted) !== 0) return { rows: [] };
        const data = JSON.parse(String(record.record_json || "{}")) as Record<string, unknown>;
        if (String(data.status ?? "active").toLowerCase() === "discontinued") return { rows: [] };
        data.unitPrice = Number(unitPrice);
        data.updatedAt = timestamp;
        db.prepare("UPDATE sector_records SET record_json=?, updated_at=? WHERE id=?")
          .run(JSON.stringify(data), timestamp, recordId);
        return { rows: [{ id: recordId } as T] };
      }

      const sqliteSql = normalizedSql.replace(/\$(\d+)/g, "?");
      if (/^(SELECT|WITH)\b/i.test(sqliteSql)) {
        return { rows: db.prepare(sqliteSql).all(...values as never[]) as T[] };
      }
      db.prepare(sqliteSql).run(...values as never[]);
      return { rows: [] };
    },
  };
  return { DB, PG } as unknown as AuthEnv;
}

function insertRecord(
  db: DatabaseSync,
  id: string,
  type: string,
  institutionId: string,
  record: Record<string, unknown>,
) {
  const timestamp = "2026-09-28T10:00:00.000Z";
  db.prepare(
    `INSERT INTO sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?,'clinic',?,NULL,NULL,?,?, 'seed',0,?,?)`,
  ).run(id, institutionId, type, JSON.stringify({ id, ...record }), timestamp, timestamp);
}

function seedClinic(db: DatabaseSync, institutionId = "clinic-1", stock = 5, unitPrice = 1500) {
  insertRecord(db, `patient-${institutionId}`, "patient", institutionId, {
    fullName: "Amina Nansubuga",
    name: "Amina Nansubuga",
    phone: "+256700000001",
    patientUid: `patient-uid-${institutionId}`,
  });
  insertRecord(db, `medicine-${institutionId}`, "pharmacy_inventory", institutionId, {
    name: "Amoxicillin 500mg",
    genericName: "Amoxicillin",
    quantityInStock: stock,
    lowStockThreshold: 2,
    unit: "capsule",
    unitPrice,
    status: "active",
  });
}

function clinicUser(role: string, institutionId = "clinic-1") {
  return { uid: "staff-1", role, institutionId } as AuthUser;
}

async function clinicRequest(
  db: DatabaseSync,
  role: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  institutionId = "clinic-1",
  beforeBatch?: () => void,
) {
  const response = await handleClinicWorkflowRoute(
    new Request(`https://appshule.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    }),
    clinicEnv(db, beforeBatch),
    clinicUser(role, institutionId),
  );
  if (!response) throw new Error(`No Clinic route handled ${method} ${path}`);
  return response;
}

describe("Clinic pharmacy checkout and sale history", () => {
  it("deducts stock once, creates an unpaid itemized bill, and returns sale history", async () => {
    const db = createClinicDb();
    try {
      seedClinic(db);
      const checkout = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        patientId: "patient-clinic-1",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 2 }],
        idempotencyKey: "checkout-once",
      });
      expect(checkout.status).toBe(201);
      const result = await checkout.json() as Record<string, any>;
      expect(result.sale).toMatchObject({
        patientName: "Amina Nansubuga",
        totalAmount: 3000,
        billStatus: "unpaid",
        balanceRemaining: 3000,
      });
      expect(result.sale.items).toEqual([{
        inventoryId: "medicine-clinic-1",
        name: "Amoxicillin 500mg",
        quantity: 2,
        unitPrice: 1500,
        lineTotal: 3000,
      }]);

      const item = JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-clinic-1'",
      ).get()?.record_json));
      expect(item.quantityInStock).toBe(3);
      const bill = JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id=?",
      ).get(result.sale.billId)?.record_json));
      expect(bill).toMatchObject({
        totalAmount: 3000,
        amountPaid: 0,
        balanceRemaining: 3000,
        currency: "UGX",
        status: "unpaid",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_manual_payments").get()?.count).toBe(0);

      const history = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/sales", "GET");
      const historyResult = await history.json() as Record<string, any>;
      expect(historyResult.sales).toHaveLength(1);
      expect(historyResult.sales[0].billId).toBe(result.sale.billId);

      const otherClinicHistory = await clinicRequest(
        db, "pharmacist", "/api/clinic/pharmacy/sales", "GET", undefined, "clinic-2",
      );
      expect((await otherClinicHistory.json() as Record<string, any>).sales).toHaveLength(0);

      const payment = await clinicRequest(
        db,
        "receptionist",
        `/api/clinic/billing/${encodeURIComponent(result.sale.billId)}/payments`,
        "POST",
        { amount: 1000, method: "cash", reference: "receipt-1", idempotencyKey: "cash-payment-1" },
      );
      expect(payment.status).toBe(201);
      const historyAfterPayment = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/sales", "GET");
      expect((await historyAfterPayment.json() as Record<string, any>).sales[0]).toMatchObject({
        billStatus: "partial",
        balanceRemaining: 2000,
      });

      const retry = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        patientId: "patient-clinic-1",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 2 }],
        idempotencyKey: "checkout-once",
      });
      expect(retry.status).toBe(200);
      expect((await retry.json() as Record<string, any>).idempotent).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_pharmacy_sales").get()?.count).toBe(1);
      expect(JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-clinic-1'",
      ).get()?.record_json)).quantityInStock).toBe(3);
    } finally {
      db.close();
    }
  });

  it("rejects changed idempotent requests, missing prices, and insufficient stock", async () => {
    const db = createClinicDb();
    try {
      seedClinic(db, "clinic-1", 1, 0);
      const unpriced = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        patientId: "patient-clinic-1",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 1 }],
        idempotencyKey: "unpriced",
      });
      expect(unpriced.status).toBe(400);

      const priceUpdate = await clinicRequest(db, "pharmacist", "/api/clinic/inventory/medicine-clinic-1/price", "POST", {
        unitPrice: 1800,
      });
      expect(priceUpdate.status).toBe(200);
      const checkoutBody = {
        patientId: "patient-clinic-1",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 1 }],
        idempotencyKey: "sale-key",
      };
      const checkout = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", checkoutBody);
      expect(checkout.status).toBe(201);

      const changedRetry = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        ...checkoutBody,
        items: [{ inventoryId: "medicine-clinic-1", quantity: 2 }],
      });
      expect(changedRetry.status).toBe(409);
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_pharmacy_sales").get()?.count).toBe(1);
      expect(JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-clinic-1'",
      ).get()?.record_json)).quantityInStock).toBe(0);

      const tooMany = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        ...checkoutBody,
        idempotencyKey: "insufficient",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 1 }],
      });
      expect(tooMany.status).toBe(409);
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_pharmacy_sales").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps checkout and sale history inside pharmacy roles and clinic tenants", async () => {
    const db = createClinicDb();
    try {
      seedClinic(db, "clinic-1");
      seedClinic(db, "clinic-2");
      const receptionist = await clinicRequest(db, "receptionist", "/api/clinic/pharmacy/sales", "GET");
      expect(receptionist.status).toBe(403);
      const doctorCheckout = await clinicRequest(db, "doctor", "/api/clinic/pharmacy/checkout", "POST", {
        patientId: "patient-clinic-1",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 1 }],
        idempotencyKey: "doctor-key",
      });
      expect(doctorCheckout.status).toBe(403);

      const crossClinic = await clinicRequest(db, "pharmacist", "/api/clinic/pharmacy/checkout", "POST", {
        patientId: "patient-clinic-2",
        items: [{ inventoryId: "medicine-clinic-1", quantity: 1 }],
        idempotencyKey: "cross-clinic",
      }, "clinic-2");
      expect(crossClinic.status).toBe(404);
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_pharmacy_sales").get()?.count).toBe(0);
      expect(JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-clinic-1'",
      ).get()?.record_json)).quantityInStock).toBe(5);
    } finally {
      db.close();
    }
  });

  it("rolls back the whole cart when stock changes before the atomic commit", async () => {
    const db = createClinicDb();
    try {
      seedClinic(db);
      insertRecord(db, "medicine-z", "pharmacy_inventory", "clinic-1", {
        name: "Paracetamol",
        quantityInStock: 2,
        lowStockThreshold: 1,
        unit: "tablet",
        unitPrice: 500,
        status: "active",
      });
      const checkout = await clinicRequest(
        db,
        "pharmacist",
        "/api/clinic/pharmacy/checkout",
        "POST",
        {
          patientId: "patient-clinic-1",
          items: [
            { inventoryId: "medicine-clinic-1", quantity: 1 },
            { inventoryId: "medicine-z", quantity: 1 },
          ],
          idempotencyKey: "atomic-cart",
        },
        "clinic-1",
        () => {
          db.prepare(
            "UPDATE sector_records SET record_json=json_set(record_json,'$.quantityInStock',0) WHERE id='medicine-z'",
          ).run();
        },
      );
      expect(checkout.status).toBe(409);
      expect(db.prepare("SELECT COUNT(*) AS count FROM clinic_pharmacy_sales").get()?.count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM sector_records WHERE record_type='billing'").get()?.count).toBe(0);
      expect(JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-clinic-1'",
      ).get()?.record_json)).quantityInStock).toBe(5);
      expect(JSON.parse(String(db.prepare(
        "SELECT record_json FROM sector_records WHERE id='medicine-z'",
      ).get()?.record_json)).quantityInStock).toBe(0);
    } finally {
      db.close();
    }
  });
});