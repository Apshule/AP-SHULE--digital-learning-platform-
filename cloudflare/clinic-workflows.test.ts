import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleClinicWorkflowRoute } from "./clinic-workflows";
import { handleDomainRoute } from "./domain-routes";
import type { AuthEnv, AuthUser } from "./backend-types";

const env = {
  PG: {
    async query() {
      throw new Error("Authorization-only Clinic tests must not query PostgreSQL");
    },
  },
} as unknown as AuthEnv;
const user = (role: string, institutionId = "clinic-1") => ({
  uid: "user-1",
  role,
  institutionId,
}) as AuthUser;

async function response(path: string, method: string, role: string, body = "{}") {
  return handleClinicWorkflowRoute(
    new Request(`https://appshule.test${path}`, { method, body: method === "GET" ? undefined : body }),
    env,
    user(role),
  );
}

describe("Cloudflare Clinic workflow access boundaries", () => {
  it("requires authentication for Clinic routes", async () => {
    const result = await handleClinicWorkflowRoute(
      new Request("https://appshule.test/api/clinic/patients", { method: "POST", body: "{}" }),
      env,
      null,
    );
    expect(result?.status).toBe(401);
  });

  it("rejects users without a Clinic role", async () => {
    const result = await response("/api/clinic/patients", "POST", "teacher");
    expect(result?.status).toBe(403);
  });

  it("keeps patient registration out of clinical and patient roles", async () => {
    for (const role of ["doctor", "nurse", "patient", "pharmacist"]) {
      const result = await response("/api/clinic/patients", "POST", role);
      expect(result?.status).toBe(403);
    }
  });

  it("keeps clinical notes and prescriptions out of reception and pharmacy roles", async () => {
    const visit = await response("/api/clinic/visits", "POST", "receptionist");
    const prescription = await response("/api/clinic/prescriptions", "POST", "nurse");
    expect(visit?.status).toBe(403);
    expect(prescription?.status).toBe(403);
  });

  it("requires tenant scope for non-superadmin Clinic accounts", async () => {
    const result = await handleClinicWorkflowRoute(
      new Request("https://appshule.test/api/clinic/patients", { method: "GET" }),
      env,
      user("clinic_admin", ""),
    );
    expect(result?.status).toBe(403);
  });

  it("leaves other Clinic routes to the existing domain router", async () => {
    const result = await response("/api/clinic/records", "GET", "clinic_admin");
    expect(result).toBeNull();
  });

  it("blocks generic CRUD from bypassing Clinic workflow rules", async () => {
    const result = await handleDomainRoute(
      new Request("https://appshule.test/api/clinic/records?type=billing", { method: "GET" }),
      env,
      user("clinic_admin"),
    );
    expect(result?.status).toBe(410);
  });

  it("restricts billing, claims review, and reports by role", async () => {
    const doctorBill = await response("/api/clinic/billing", "POST", "doctor");
    const patientClaim = await response("/api/clinic/claims", "POST", "patient");
    const receptionistReport = await response("/api/clinic/reports", "GET", "receptionist");
    expect(doctorBill?.status).toBe(403);
    expect(patientClaim?.status).toBe(403);
    expect(receptionistReport?.status).toBe(403);
  });

  it("enforces unique appointment slots and safe dispensing in D1", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE sector_records (
        id TEXT PRIMARY KEY, sector TEXT, institution_id TEXT, record_type TEXT,
        record_json TEXT, is_deleted INTEGER, created_at TEXT, updated_at TEXT
      )`);
      db.exec(readFileSync(new URL("./migrations/0010_clinic_workflow_guards.sql", import.meta.url), "utf8"));
      const insert = db.prepare("INSERT INTO sector_records VALUES (?,?,?,?,?,?,?,?)");
      const slot = { doctorId: "doctor-1", appointmentDate: "2026-10-01", appointmentTime: "09:00", status: "scheduled" };
      insert.run("appointment-1", "clinic", "clinic-1", "appointment", JSON.stringify(slot), 0, "t", "t");
      expect(() => insert.run("appointment-2", "clinic", "clinic-1", "appointment", JSON.stringify(slot), 0, "t", "t")).toThrow();
      db.prepare("UPDATE sector_records SET record_json=json_set(record_json,'$.status','cancelled') WHERE id=?").run("appointment-1");
      expect(() => insert.run("appointment-2", "clinic", "clinic-1", "appointment", JSON.stringify(slot), 0, "t", "t")).not.toThrow();

      insert.run("stock-1", "clinic", "clinic-1", "pharmacy_inventory",
        JSON.stringify({ name: "Amoxicillin", genericName: "Amoxicillin", quantityInStock: 4 }), 0, "t", "t");
      const adjustment = db.prepare(
        "INSERT INTO clinic_stock_adjustments (id,institution_id,inventory_record_id,delta,idempotency_key,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
      );
      adjustment.run("adjustment-1", "clinic-1", "stock-1", -1, "retry-key-1", "dispensing", "pharmacist-1", "t");
      expect(() => adjustment.run("adjustment-2", "clinic-1", "stock-1", -1, "retry-key-1", "retry", "pharmacist-1", "t")).toThrow();
      let adjustedStock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id=?").get("stock-1")?.record_json));
      expect(adjustedStock.quantityInStock).toBe(3);
      expect(() => adjustment.run("adjustment-3", "clinic-1", "stock-1", -10, "retry-key-2", "overdraw", "pharmacist-1", "t")).toThrow();
      adjustedStock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id=?").get("stock-1")?.record_json));
      expect(adjustedStock.quantityInStock).toBe(3);
      insert.run("prescription-1", "clinic", "clinic-1", "prescription",
        JSON.stringify({ medicineName: "Amoxicillin", quantity: 2, status: "ready" }), 0, "t", "t");
      db.prepare("UPDATE sector_records SET record_json=json_set(record_json,'$.status','dispensed') WHERE id=?").run("prescription-1");
      const stock = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id=?").get("stock-1")?.record_json));
      expect(stock.quantityInStock).toBe(1);
      expect(() => db.prepare("UPDATE sector_records SET record_json=json_set(record_json,'$.quantityInStock',-1) WHERE id=?").run("stock-1")).toThrow();

      insert.run("bill-1", "clinic", "clinic-1", "billing",
        JSON.stringify({ totalAmount: 100, amountPaid: 0, balanceRemaining: 100, status: "unpaid" }), 0, "t", "t");
      const payment = db.prepare(
        "INSERT INTO clinic_manual_payments (id,institution_id,bill_record_id,patient_id,owner_uid,amount,method,reference,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      payment.run("payment-1", "clinic-1", "bill-1", "patient-1", "patient-uid", 40, "cash", "", "payment-key-1", "cashier-1", "t");
      let bill = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id=?").get("bill-1")?.record_json));
      expect(bill).toMatchObject({ amountPaid: 40, balanceRemaining: 60, status: "partial" });
      expect(() => payment.run("payment-2", "clinic-1", "bill-1", "patient-1", "patient-uid", 40, "cash", "", "payment-key-1", "cashier-1", "t")).toThrow();
      expect(() => payment.run("payment-3", "clinic-1", "bill-1", "patient-1", "patient-uid", 70, "cash", "", "payment-key-2", "cashier-1", "t")).toThrow();
      payment.run("payment-4", "clinic-1", "bill-1", "patient-1", "patient-uid", 60, "cash", "", "payment-key-3", "cashier-1", "t");
      bill = JSON.parse(String(db.prepare("SELECT record_json FROM sector_records WHERE id=?").get("bill-1")?.record_json));
      expect(bill).toMatchObject({ amountPaid: 100, balanceRemaining: 0, status: "paid" });
      expect(() => db.prepare("UPDATE sector_records SET record_json=json_set(record_json,'$.description','changed') WHERE id=?").run("bill-1")).toThrow();
      db.prepare("UPDATE sector_records SET record_json=json_set(record_json,'$.status','reversed') WHERE id=?").run("bill-1");
    } finally {
      db.close();
    }
  });
});