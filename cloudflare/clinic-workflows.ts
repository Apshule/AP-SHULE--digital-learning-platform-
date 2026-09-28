import type { AuthEnv, AuthUser } from "./backend-types";
import { readRecords } from "./domain-routes";

type RecordData = Record<string, unknown>;
type ClinicRole = "clinic_admin" | "doctor" | "nurse" | "receptionist" | "pharmacist" | "patient";

const clinicRoles = new Set<ClinicRole>(["clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient"]);
const clinicalRoles = new Set(["clinic_admin", "doctor", "nurse"]);
const adminRoles = new Set(["clinic_admin", "superadmin"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value: unknown, limit = 240): string {
  return String(value ?? "").replace(/\0/g, "").trim().slice(0, limit);
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function ownPatient(user: AuthUser, patient: RecordData): boolean {
  return [patient.patientUid, patient.userUid, patient.uid, patient.ownerUid].some((value) => clean(value, 160) === user.uid);
}

async function parseBody(request: Request): Promise<RecordData | null> {
  try {
    const data: unknown = await request.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data as RecordData : null;
  } catch {
    return null;
  }
}

async function list(env: AuthEnv, user: AuthUser, type: string): Promise<RecordData[]> {
  return readRecords(env, user, "clinic", type);
}

async function save(
  env: AuthEnv,
  user: AuthUser,
  type: string,
  record: RecordData,
  ownerUid: string | null = null,
): Promise<RecordData> {
  const id = clean(record.id, 300) || makeId(type);
  const timestamp = new Date().toISOString();
  const institutionId = clean(user.institutionId, 160);
  const payload = { ...record, id, recordType: type, institutionId, updatedAt: timestamp };
  await env.DB.prepare(
    `INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?,?,?,NULL,?,?,?, ?,0,?,?)
     ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,owner_uid=excluded.owner_uid,updated_at=excluded.updated_at
     WHERE sector_records.sector='clinic' AND sector_records.institution_id=excluded.institution_id`,
  ).bind(id, "clinic", institutionId, ownerUid, type, JSON.stringify(payload), user.uid, timestamp, timestamp).run();
  await env.DB.prepare(
    "INSERT INTO audit (id,institution_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(makeId("audit"), institutionId, user.uid, "clinic.record.save", type, id, "{}", timestamp).run();
  return payload;
}

async function ensureStored(
  env: AuthEnv,
  user: AuthUser,
  type: string,
  record: RecordData,
  ownerUid: string | null = null,
): Promise<void> {
  const id = clean(record.id, 300);
  if (!id) throw new Error("Clinic record ID is required");
  const timestamp = new Date().toISOString();
  const payload = { ...record, id, recordType: type, institutionId: user.institutionId, updatedAt: record.updatedAt || timestamp };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sector_records
      (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES (?, 'clinic', ?, NULL, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    id, user.institutionId, ownerUid, type, JSON.stringify(payload), user.uid,
    clean(record.createdAt, 32) || timestamp, timestamp,
  ).run();
}

async function scopedPatient(env: AuthEnv, user: AuthUser, patientId: string): Promise<RecordData | null> {
  const patients = await list(env, user, "patient");
  return patients.find((patient) => clean(patient.id, 300) === patientId
    || clean(patient.id, 300).endsWith(`/${patientId}`)) || null;
}

async function workspace(env: AuthEnv, user: AuthUser, role: ClinicRole | "superadmin") {
  const result: RecordData = { ok: true, role, institutionId: user.institutionId || null };
  const isPatient = role === "patient";
  result.patients = await list(env, user, "patient");
  if (["clinic_admin", "doctor", "nurse", "receptionist", "patient", "superadmin"].includes(role)) {
    result.appointments = await list(env, user, "appointment");
  }
  if (clinicalRoles.has(role)) {
    result.visits = await list(env, user, "visit");
    result.prescriptions = await list(env, user, "prescription");
  } else if (role === "pharmacist") {
    result.prescriptions = await list(env, user, "prescription");
    result.inventory = await list(env, user, "pharmacy_inventory");
  } else if (isPatient) {
    result.visits = await list(env, user, "visit");
    result.prescriptions = await list(env, user, "prescription");
    result.billing = await list(env, user, "billing");
    result.claims = await list(env, user, "insurance_claim");
    result.payments = await manualPayments(env, user, true);
  } else if (role === "receptionist") {
    result.billing = await list(env, user, "billing");
    result.claims = await list(env, user, "insurance_claim");
    result.payments = await manualPayments(env, user, false);
  }
  if (adminRoles.has(role)) {
    result.inventory = await list(env, user, "pharmacy_inventory");
    result.billing = await list(env, user, "billing");
    result.claims = await list(env, user, "insurance_claim");
    result.payments = await manualPayments(env, user, false);
    result.services = await list(env, user, "service");
    result.branches = await list(env, user, "branch");
  }
  return result;
}

async function manualPayments(env: AuthEnv, user: AuthUser, ownOnly: boolean): Promise<RecordData[]> {
  const query = ownOnly
    ? "SELECT id,bill_record_id AS billId,patient_id AS patientId,amount,method,reference,created_at AS createdAt FROM clinic_manual_payments WHERE institution_id=? AND owner_uid=? ORDER BY created_at DESC LIMIT 500"
    : "SELECT id,bill_record_id AS billId,patient_id AS patientId,amount,method,reference,created_at AS createdAt FROM clinic_manual_payments WHERE institution_id=? ORDER BY created_at DESC LIMIT 500";
  const statement = env.DB.prepare(query);
  const result = ownOnly
    ? await statement.bind(user.institutionId, user.uid).all<RecordData>()
    : await statement.bind(user.institutionId).all<RecordData>();
  return result.results;
}

const pharmacySalesSql = `
  SELECT
    sale.id,
    sale.bill_record_id AS billId,
    sale.patient_id AS patientId,
    sale.patient_name AS patientName,
    sale.total_amount AS totalAmount,
    sale.created_by AS createdBy,
    sale.created_at AS createdAt,
    json_extract(bill.record_json, '$.invoiceNumber') AS invoiceNumber,
    coalesce(json_extract(bill.record_json, '$.status'), 'missing') AS billStatus,
    coalesce(
      CAST(json_extract(bill.record_json, '$.balanceRemaining') AS INTEGER),
      CAST(json_extract(bill.record_json, '$.totalAmount') AS INTEGER),
      sale.total_amount
    ) AS balanceRemaining,
    json_group_array(json_object(
      'inventoryId', line.inventory_record_id,
      'name', line.item_name,
      'quantity', line.quantity,
      'unitPrice', line.unit_price,
      'lineTotal', line.line_total
    )) AS itemsJson
  FROM clinic_pharmacy_sales AS sale
  JOIN clinic_pharmacy_sale_items AS line
    ON line.sale_id = sale.id AND line.institution_id = sale.institution_id
  LEFT JOIN sector_records AS bill
    ON bill.id = sale.bill_record_id
    AND bill.sector = 'clinic'
    AND bill.institution_id = sale.institution_id
    AND bill.record_type IN ('billing', 'clinic_billing')
    AND bill.is_deleted = 0
`;

async function pharmacySales(env: AuthEnv, institutionId: string, saleId?: string): Promise<RecordData[]> {
  const filter = saleId ? " AND sale.id=?" : "";
  const query = `${pharmacySalesSql}
    WHERE sale.institution_id=?${filter}
    GROUP BY sale.id, bill.record_json
    ORDER BY sale.created_at DESC
    LIMIT ${saleId ? "1" : "100"}`;
  const result = saleId
    ? await env.DB.prepare(query).bind(institutionId, saleId).all<RecordData>()
    : await env.DB.prepare(query).bind(institutionId).all<RecordData>();
  return result.results.map((row) => {
    let items: RecordData[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.itemsJson || "[]"));
      if (Array.isArray(parsed)) items = parsed as RecordData[];
    } catch {
      items = [];
    }
    items.sort((a, b) => clean(a.name, 160).localeCompare(clean(b.name, 160)));
    return {
      id: row.id,
      billId: row.billId,
      invoiceNumber: row.invoiceNumber,
      patientId: row.patientId,
      patientName: row.patientName,
      totalAmount: Number(row.totalAmount),
      currency: "UGX",
      billStatus: clean(row.billStatus, 32),
      balanceRemaining: Number(row.balanceRemaining),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      items,
    };
  });
}

async function existingPharmacySale(
  env: AuthEnv,
  institutionId: string,
  idempotencyKey: string,
): Promise<{ id: string; requestJson: string } | null> {
  const result = await env.DB.prepare(
    "SELECT id,request_json AS requestJson FROM clinic_pharmacy_sales WHERE institution_id=? AND idempotency_key=? LIMIT 1",
  ).bind(institutionId, idempotencyKey).all<RecordData>();
  const row = result.results[0];
  return row ? { id: clean(row.id, 300), requestJson: String(row.requestJson || "") } : null;
}

export async function handleClinicWorkflowRoute(
  request: Request,
  env: AuthEnv,
  user: AuthUser | null | undefined,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/clinic/workspace")
    && !url.pathname.startsWith("/api/clinic/patients")
    && !url.pathname.startsWith("/api/clinic/appointments")
    && !url.pathname.startsWith("/api/clinic/visits")
    && !url.pathname.startsWith("/api/clinic/prescriptions")
    && !url.pathname.startsWith("/api/clinic/inventory")
    && !url.pathname.startsWith("/api/clinic/pharmacy")
    && !url.pathname.startsWith("/api/clinic/billing")
    && !url.pathname.startsWith("/api/clinic/claims")
    && !url.pathname.startsWith("/api/clinic/reports")) return null;
  if (!user) return json({ ok: false, error: "Authentication required" }, 401);
  const role = clean(user.role, 80).toLowerCase();
  if (!clinicRoles.has(role as ClinicRole) && role !== "superadmin") return json({ ok: false, error: "Clinic access required" }, 403);
  if (role !== "superadmin" && !user.institutionId) return json({ ok: false, error: "Clinic institution scope is required" }, 403);
  if (!user.institutionId) return json({ ok: false, error: "Select a clinic institution before continuing" }, 400);

  if (url.pathname === "/api/clinic/workspace" && request.method === "GET") {
    return json(await workspace(env, user, role as ClinicRole | "superadmin"));
  }

  if (url.pathname === "/api/clinic/pharmacy/sales" && request.method === "GET") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) {
      return json({ ok: false, error: "Pharmacy sales access required" }, 403);
    }
    return json({ ok: true, sales: await pharmacySales(env, user.institutionId) });
  }

  if (url.pathname === "/api/clinic/pharmacy/checkout" && request.method === "POST") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) {
      return json({ ok: false, error: "Pharmacy checkout is restricted" }, 403);
    }
    const input = await parseBody(request);
    const idempotencyKey = clean(input?.idempotencyKey, 180);
    const requestedPatientId = clean(input?.patientId, 300);
    if (!input || !idempotencyKey || !requestedPatientId || !Array.isArray(input.items)
      || input.items.length < 1 || input.items.length > 50) {
      return json({ ok: false, error: "Patient, checkout key, and 1 to 50 cart items are required" }, 400);
    }

    const quantities = new Map<string, number>();
    for (const rawLine of input.items) {
      if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
        return json({ ok: false, error: "Each cart item must include an inventory item and quantity" }, 400);
      }
      const line = rawLine as RecordData;
      const inventoryId = clean(line.inventoryId, 300);
      const quantity = Number(line.quantity);
      if (!inventoryId || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10000) {
        return json({ ok: false, error: "Cart quantities must be positive whole numbers no greater than 10,000" }, 400);
      }
      const combined = (quantities.get(inventoryId) || 0) + quantity;
      if (!Number.isSafeInteger(combined) || combined > 10000) {
        return json({ ok: false, error: "Combined item quantity exceeds the checkout limit" }, 400);
      }
      quantities.set(inventoryId, combined);
    }
    const normalizedRequest = {
      patientId: requestedPatientId,
      items: [...quantities.entries()]
        .map(([inventoryId, quantity]) => ({ inventoryId, quantity }))
        .sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)),
    };
    const requestJson = JSON.stringify(normalizedRequest);
    const prior = await existingPharmacySale(env, user.institutionId, idempotencyKey);
    if (prior) {
      if (prior.requestJson !== requestJson) {
        return json({ ok: false, error: "This checkout key was already used for different cart details" }, 409);
      }
      const existing = (await pharmacySales(env, user.institutionId, prior.id))[0];
      return existing
        ? json({ ok: true, idempotent: true, sale: existing })
        : json({ ok: false, error: "The earlier checkout exists but its sale details are unavailable" }, 409);
    }

    const patient = await scopedPatient(env, user, requestedPatientId);
    if (!patient) return json({ ok: false, error: "Select a patient registered in this clinic" }, 404);
    const inventory = await list(env, user, "pharmacy_inventory");
    const inventoryRecords = new Map<string, RecordData>();
    const lines: Array<{
      inventoryId: string;
      name: string;
      quantity: number;
      unitPrice: number;
      lineTotal: number;
    }> = [];
    for (const requested of normalizedRequest.items) {
      const item = inventory.find((row) =>
        clean(row.id, 300) === requested.inventoryId
        || clean(row.id, 300).endsWith(`/${requested.inventoryId}`),
      );
      if (!item) return json({ ok: false, error: "One or more cart items are outside this clinic" }, 404);
      if (clean(item.status, 40).toLowerCase() === "discontinued") {
        return json({ ok: false, error: `${clean(item.name, 160) || "An item"} is discontinued` }, 409);
      }
      const stock = Number(item.quantityInStock);
      const unitPrice = Number(item.unitPrice);
      if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) {
        return json({ ok: false, error: `Set a positive whole-number UGX price for ${clean(item.name, 160) || "each item"} before checkout` }, 400);
      }
      if (!Number.isFinite(stock) || stock < requested.quantity) {
        return json({ ok: false, error: `Insufficient stock for ${clean(item.name, 160) || "an item"}` }, 409);
      }
      const lineTotal = requested.quantity * unitPrice;
      if (!Number.isSafeInteger(lineTotal) || lineTotal <= 0) {
        return json({ ok: false, error: "Cart total is outside the supported UGX range" }, 400);
      }
      lines.push({
        inventoryId: clean(item.id, 300),
        name: clean(item.name, 160),
        quantity: requested.quantity,
        unitPrice,
        lineTotal,
      });
      inventoryRecords.set(clean(item.id, 300), item);
    }
    const totalAmount = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
      return json({ ok: false, error: "Cart total is outside the supported UGX range" }, 400);
    }
    for (const line of lines) {
      const item = inventoryRecords.get(line.inventoryId);
      if (item) await ensureStored(env, user, "pharmacy_inventory", item);
    }

    const timestamp = new Date().toISOString();
    const saleId = makeId("pharmacy_sale");
    const billId = makeId("bill");
    const ownerUid = clean(patient.patientUid || patient.userUid || patient.uid, 160) || null;
    const patientName = clean(patient.fullName || patient.name, 160);
    const invoiceNumber = `CL-PH-${timestamp.slice(0, 10).replaceAll("-", "")}-${billId.slice(-6).toUpperCase()}`;
    const bill = {
      id: billId,
      recordType: "billing",
      institutionId: user.institutionId,
      patientId: clean(patient.id, 300),
      patientName,
      invoiceNumber,
      billDate: timestamp.slice(0, 10),
      description: `Pharmacy checkout ${saleId}`,
      items: lines.map((line) => ({
        description: `${line.name} × ${line.quantity}`,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.lineTotal,
      })),
      total: totalAmount,
      totalAmount,
      amountPaid: 0,
      balanceRemaining: totalAmount,
      currency: "UGX",
      status: "unpaid",
      pharmacySaleId: saleId,
      createdAt: timestamp,
      createdBy: user.uid,
    };
    const statements = [
      env.DB.prepare(
        `INSERT INTO clinic_pharmacy_sales
          (id,institution_id,bill_record_id,patient_id,patient_name,owner_uid,idempotency_key,request_json,total_amount,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        saleId, user.institutionId, billId, clean(patient.id, 300), patientName, ownerUid,
        idempotencyKey, requestJson, totalAmount, user.uid, timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO sector_records
          (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
         VALUES (?,'clinic',?,NULL,?,'billing',?,?,0,?,?)`,
      ).bind(billId, user.institutionId, ownerUid, JSON.stringify(bill), user.uid, timestamp, timestamp),
      ...lines.map((line) => env.DB.prepare(
        `INSERT INTO clinic_pharmacy_sale_items
          (id,sale_id,institution_id,inventory_record_id,item_name,quantity,unit_price,line_total,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        makeId("sale_item"), saleId, user.institutionId, line.inventoryId, line.name,
        line.quantity, line.unitPrice, line.lineTotal, timestamp,
      )),
      env.DB.prepare(
        `INSERT INTO audit
          (id,institution_id,actor_id,action,resource_type,resource_id,metadata_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        makeId("audit"), user.institutionId, user.uid, "clinic.pharmacy.checkout",
        "pharmacy_sale", saleId, JSON.stringify({ billId, totalAmount, lineCount: lines.length }), timestamp,
      ),
    ];

    try {
      await env.DB.batch(statements);
    } catch {
      const raced = await existingPharmacySale(env, user.institutionId, idempotencyKey);
      if (raced) {
        if (raced.requestJson !== requestJson) {
          return json({ ok: false, error: "This checkout key was already used for different cart details" }, 409);
        }
        const existing = (await pharmacySales(env, user.institutionId, raced.id))[0];
        return existing
          ? json({ ok: true, idempotent: true, sale: existing })
          : json({ ok: false, error: "The earlier checkout exists but its sale details are unavailable" }, 409);
      }
      return json({ ok: false, error: "Checkout was not completed; review current stock and item prices, then retry" }, 409);
    }

    const sale = (await pharmacySales(env, user.institutionId, saleId))[0];
    return sale
      ? json({ ok: true, sale }, 201)
      : json({ ok: false, error: "Checkout committed but its sale history could not be loaded" }, 500);
  }

  if (url.pathname === "/api/clinic/patients" && request.method === "GET") {
    if (!["clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient", "superadmin"].includes(role)) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    return json({ ok: true, records: await list(env, user, "patient") });
  }

  if (url.pathname === "/api/clinic/patients" && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "superadmin"].includes(role)) return json({ ok: false, error: "Patient registration is restricted" }, 403);
    const input = await parseBody(request);
    if (!input) return json({ ok: false, error: "A JSON patient record is required" }, 400);
    const fullName = clean(input.fullName || input.name, 160);
    const phone = clean(input.phone, 80);
    if (!fullName || !phone) return json({ ok: false, error: "Patient name and phone are required" }, 400);
    const patients = await list(env, user, "patient");
    if (patients.some((row) => clean(row.phone, 80).replace(/\s/g, "") === phone.replace(/\s/g, ""))) {
      return json({ ok: false, error: "A patient with this phone number is already registered" }, 409);
    }
    const patientUid = clean(input.patientUid, 160);
    if (patientUid) {
      const account = await env.DB.prepare(
        "SELECT uid FROM users WHERE uid=? AND lower(role)='patient' AND institution_id=? AND active=1 AND disabled=0 LIMIT 1",
      ).bind(patientUid, user.institutionId).all<RecordData>();
      if (!account.results[0]) return json({ ok: false, error: "Linked patient account must already belong to this clinic" }, 400);
    }
    const patient = await save(env, user, "patient", {
      fullName, name: fullName, phone, email: clean(input.email, 180).toLowerCase(),
      sex: clean(input.sex, 40), dateOfBirth: clean(input.dateOfBirth, 32),
      address: clean(input.address, 300), emergencyContact: clean(input.emergencyContact, 160),
      patientUid,
      status: "active", createdAt: new Date().toISOString(),
    }, patientUid || null);
    return json({ ok: true, patient }, 201);
  }

  if (url.pathname === "/api/clinic/appointments" && request.method === "GET") {
    if (!["clinic_admin", "doctor", "nurse", "receptionist", "patient", "superadmin"].includes(role)) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    return json({ ok: true, records: await list(env, user, "appointment") });
  }

  if (url.pathname === "/api/clinic/appointments" && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "patient", "superadmin"].includes(role)) return json({ ok: false, error: "Appointment scheduling is restricted" }, 403);
    const input = await parseBody(request);
    if (!input) return json({ ok: false, error: "A JSON appointment is required" }, 400);
    const patientId = clean(input.patientId, 300);
    const patient = await scopedPatient(env, user, patientId);
    if (!patient || role === "patient" && !ownPatient(user, patient)) return json({ ok: false, error: "Patient is outside your account or clinic" }, 403);
    const doctorId = clean(input.doctorId, 160);
    const appointmentDate = clean(input.appointmentDate, 20);
    const appointmentTime = clean(input.appointmentTime, 20);
    const reason = clean(input.reason, 500);
    if (!doctorId || !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) || !/^\d{2}:\d{2}$/.test(appointmentTime) || !reason) {
      return json({ ok: false, error: "Doctor, date, time, and appointment reason are required" }, 400);
    }
    const doctor = await env.DB.prepare(
      "SELECT uid FROM users WHERE uid=? AND lower(role)='doctor' AND institution_id=? AND active=1 AND disabled=0 LIMIT 1",
    ).bind(doctorId, user.institutionId).all<RecordData>();
    if (!doctor.results[0]) return json({ ok: false, error: "Select an active doctor from this clinic" }, 400);
    const appointments = await list(env, user, "appointment");
    const conflict = appointments.some((row) =>
      clean(row.doctorId, 160) === doctorId &&
      clean(row.appointmentDate, 20) === appointmentDate &&
      clean(row.appointmentTime, 20) === appointmentTime &&
      !["cancelled", "no_show"].includes(clean(row.status, 40)),
    );
    if (conflict) return json({ ok: false, error: "That doctor already has an appointment at this time." }, 409);
    const timestamp = new Date().toISOString();
    const appointment = await save(env, user, "appointment", {
      patientId: clean(patient.id, 300), patientName: clean(patient.fullName || patient.name, 160),
      doctorId, appointmentDate, appointmentTime, reason, branchId: clean(input.branchId, 160),
      status: "scheduled", createdAt: timestamp,
    }, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
    return json({ ok: true, appointment }, 201);
  }

  const appointmentPath = url.pathname.split("/");
  const checkInId = appointmentPath.length === 6 && appointmentPath[1] === "api"
    && appointmentPath[2] === "clinic" && appointmentPath[3] === "appointments"
    && appointmentPath[5] === "check-in" ? appointmentPath[4] : "";
  if (checkInId && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "superadmin"].includes(role)) return json({ ok: false, error: "Check-in is restricted to reception" }, 403);
    const appointment = (await list(env, user, "appointment")).find((row) =>
      clean(row.id, 300) === decodeSegment(checkInId) || clean(row.id, 300).endsWith(`/${decodeSegment(checkInId)}`),
    );
    if (!appointment) return json({ ok: false, error: "Appointment not found" }, 404);
    if (["cancelled", "no_show", "completed"].includes(clean(appointment.status, 40))) {
      return json({ ok: false, error: "This appointment cannot be checked in" }, 409);
    }
    const updated = await save(env, user, "appointment", {
      ...appointment, status: "checked_in", checkedInAt: new Date().toISOString(), checkedInBy: user.uid,
    }, clean((await scopedPatient(env, user, clean(appointment.patientId, 300)))?.patientUid, 160) || null);
    return json({ ok: true, appointment: updated });
  }

  if (url.pathname === "/api/clinic/visits" && request.method === "POST") {
    if (!clinicalRoles.has(role) && role !== "superadmin") return json({ ok: false, error: "Clinical access required" }, 403);
    const input = await parseBody(request);
    if (!input) return json({ ok: false, error: "A JSON visit record is required" }, 400);
    const patient = await scopedPatient(env, user, clean(input.patientId, 300));
    if (!patient) return json({ ok: false, error: "Patient not found in this clinic" }, 404);
    const symptoms = clean(input.symptoms, 2000);
    if (!symptoms) return json({ ok: false, error: "Symptoms or complaint are required" }, 400);
    const vitals = input.vitals && typeof input.vitals === "object" && !Array.isArray(input.vitals)
      ? input.vitals as RecordData : {};
    const temperature = Number(vitals.temperature);
    const pulse = Number(vitals.pulse);
    const respiratoryRate = Number(vitals.respiratoryRate);
    const weightKg = Number(vitals.weightKg);
    const heightCm = Number(vitals.heightCm);
    if (vitals.temperature !== undefined && (!Number.isFinite(temperature) || temperature < 25 || temperature > 45)
      || vitals.pulse !== undefined && (!Number.isFinite(pulse) || pulse < 20 || pulse > 250)
      || vitals.respiratoryRate !== undefined && (!Number.isFinite(respiratoryRate) || respiratoryRate < 5 || respiratoryRate > 80)
      || vitals.weightKg !== undefined && (!Number.isFinite(weightKg) || weightKg <= 0)
      || vitals.heightCm !== undefined && (!Number.isFinite(heightCm) || heightCm <= 0)) {
      return json({ ok: false, error: "One or more vital-sign values are outside the supported range" }, 400);
    }
    const bmi = weightKg > 0 && heightCm > 0 ? Math.round(weightKg / ((heightCm / 100) ** 2) * 10) / 10 : null;
    const visit = await save(env, user, "visit", {
      patientId: clean(patient.id, 300), patientName: clean(patient.fullName || patient.name, 160),
      appointmentId: clean(input.appointmentId, 300), symptoms, vitals,
      bmi, clinicalNotes: role === "nurse" ? "" : clean(input.clinicalNotes, 4000),
      doctorId: role === "doctor" ? user.uid : clean(input.doctorId, 160),
      nurseId: role === "nurse" ? user.uid : clean(input.nurseId, 160),
      visitDate: new Date().toISOString(), createdAt: new Date().toISOString(),
    }, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
    return json({ ok: true, visit }, 201);
  }

  if (url.pathname === "/api/clinic/prescriptions" && request.method === "POST") {
    if (!["clinic_admin", "doctor", "superadmin"].includes(role)) return json({ ok: false, error: "Only a doctor can issue a prescription" }, 403);
    const input = await parseBody(request);
    if (!input) return json({ ok: false, error: "A JSON prescription is required" }, 400);
    const patient = await scopedPatient(env, user, clean(input.patientId, 300));
    const medicineName = clean(input.medicineName, 160);
    const dosage = clean(input.dosage, 120);
    const frequency = clean(input.frequency, 120);
    const duration = clean(input.duration, 120);
    if (!patient || !medicineName || !dosage || !frequency || !duration) {
      return json({ ok: false, error: "Patient, medicine, dosage, frequency, and duration are required" }, 400);
    }
    const prescription = await save(env, user, "prescription", {
      patientId: clean(patient.id, 300), patientName: clean(patient.fullName || patient.name, 160),
      visitId: clean(input.visitId, 300), medicineName, dosage, frequency, duration,
      quantity: Math.max(1, Math.min(1000, Math.floor(Number(input.quantity) || 1))),
      status: "ready", doctorId: user.uid, createdAt: new Date().toISOString(),
    }, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
    return json({ ok: true, prescription }, 201);
  }

  if (url.pathname === "/api/clinic/inventory" && request.method === "GET") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) return json({ ok: false, error: "Pharmacy access required" }, 403);
    return json({ ok: true, records: await list(env, user, "pharmacy_inventory") });
  }

  if (url.pathname === "/api/clinic/inventory" && request.method === "POST") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) return json({ ok: false, error: "Pharmacy access required" }, 403);
    const input = await parseBody(request);
    if (!input) return json({ ok: false, error: "A JSON inventory item is required" }, 400);
    const name = clean(input.name, 160);
    const quantityInStock = Number(input.quantityInStock);
    const lowStockThreshold = Number(input.lowStockThreshold ?? 5);
    const unitPrice = input.unitPrice === undefined || input.unitPrice === "" ? 0 : Number(input.unitPrice);
    if (!name || !Number.isFinite(quantityInStock) || quantityInStock < 0
      || !Number.isFinite(lowStockThreshold) || lowStockThreshold < 0
      || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      return json({ ok: false, error: "Item name, non-negative stock/reorder values, and a non-negative whole-number UGX price are required" }, 400);
    }
    const item = await save(env, user, "pharmacy_inventory", {
      name, genericName: clean(input.genericName, 160), category: clean(input.category, 100),
      barcode: clean(input.barcode, 80),
      quantityInStock, lowStockThreshold, unit: clean(input.unit, 40) || "unit",
      unitPrice, expiryDate: clean(input.expiryDate, 32),
      status: "active", createdAt: new Date().toISOString(),
    });
    return json({ ok: true, item }, 201);
  }

  const adjustId = url.pathname.match(/^\/api\/clinic\/inventory\/([^/]+)\/adjust$/)?.[1];
  if (adjustId && request.method === "POST") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) return json({ ok: false, error: "Pharmacy access required" }, 403);
    const input = await parseBody(request);
    const delta = Number(input?.delta);
    const idempotencyKey = clean(input?.idempotencyKey, 180);
    if (!input || !Number.isInteger(delta) || delta === 0 || !idempotencyKey) {
      return json({ ok: false, error: "A non-zero whole-number adjustment and idempotency key are required" }, 400);
    }
    const id = decodeSegment(adjustId);
    const item = (await list(env, user, "pharmacy_inventory")).find((row) =>
      clean(row.id, 300) === id || clean(row.id, 300).endsWith(`/${id}`),
    );
    if (!item) return json({ ok: false, error: "Inventory item not found" }, 404);
    if (clean(item.status, 40) === "discontinued") return json({ ok: false, error: "Discontinued inventory cannot be adjusted" }, 409);
    const recordId = clean(item.id, 300);
    const prior = await env.DB.prepare(
      "SELECT id,inventory_record_id,delta FROM clinic_stock_adjustments WHERE institution_id=? AND idempotency_key=? LIMIT 1",
    ).bind(user.institutionId, idempotencyKey).all<RecordData>();
    if (prior.results[0]) {
      if (clean(prior.results[0].inventory_record_id, 300) !== recordId || Number(prior.results[0].delta) !== delta) {
        return json({ ok: false, error: "This idempotency key was already used for a different adjustment" }, 409);
      }
      return json({ ok: true, idempotent: true, adjustment: prior.results[0] });
    }
    const timestamp = new Date().toISOString();
    await ensureStored(env, user, "pharmacy_inventory", item);
    try {
      await env.DB.prepare(
        `INSERT INTO clinic_stock_adjustments
          (id,institution_id,inventory_record_id,delta,idempotency_key,reason,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(makeId("stock_adjustment"), user.institutionId, recordId, delta, idempotencyKey, clean(input.reason, 240), user.uid, timestamp).run();
    } catch {
      const raced = await env.DB.prepare(
        "SELECT id,inventory_record_id,delta FROM clinic_stock_adjustments WHERE institution_id=? AND idempotency_key=? LIMIT 1",
      ).bind(user.institutionId, idempotencyKey).all<RecordData>();
      if (raced.results[0]) {
        if (clean(raced.results[0].inventory_record_id, 300) !== recordId || Number(raced.results[0].delta) !== delta) {
          return json({ ok: false, error: "This idempotency key was already used for a different adjustment" }, 409);
        }
        return json({ ok: true, idempotent: true, adjustment: raced.results[0] });
      }
      return json({ ok: false, error: "Adjustment was rejected; verify available stock and try again" }, 409);
    }
    const saved = await env.DB.prepare("SELECT record_json FROM sector_records WHERE id=? AND sector='clinic' AND institution_id=? LIMIT 1")
      .bind(recordId, user.institutionId).all<RecordData>();
    await env.DB.prepare(
      "INSERT INTO audit (id,institution_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(makeId("audit"), user.institutionId, user.uid, "clinic.stock.adjust", "pharmacy_inventory", recordId, JSON.stringify({ delta }), timestamp).run();
    return json({ ok: true, item: saved.results[0] ? JSON.parse(String(saved.results[0].record_json)) : null });
  }

  const priceId = url.pathname.match(/^\/api\/clinic\/inventory\/([^/]+)\/price$/)?.[1];
  if (priceId && request.method === "POST") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) {
      return json({ ok: false, error: "Pharmacy access required" }, 403);
    }
    const input = await parseBody(request);
    const unitPrice = Number(input?.unitPrice);
    if (!input || !Number.isSafeInteger(unitPrice) || unitPrice <= 0) {
      return json({ ok: false, error: "A positive whole-number UGX unit price is required" }, 400);
    }
    const id = decodeSegment(priceId);
    const item = (await list(env, user, "pharmacy_inventory")).find((row) =>
      clean(row.id, 300) === id || clean(row.id, 300).endsWith(`/${id}`),
    );
    if (!item) return json({ ok: false, error: "Inventory item not found" }, 404);
    if (clean(item.status, 40).toLowerCase() === "discontinued") {
      return json({ ok: false, error: "Discontinued inventory cannot be repriced" }, 409);
    }
    const recordId = clean(item.id, 300);
    await ensureStored(env, user, "pharmacy_inventory", item);
    const timestamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sector_records
         SET record_json=json_set(record_json, '$.unitPrice', ?, '$.updatedAt', ?), updated_at=?
         WHERE id=? AND sector='clinic' AND institution_id=?
           AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
           AND is_deleted=0
           AND coalesce(json_extract(record_json, '$.status'), 'active') <> 'discontinued'`,
      ).bind(unitPrice, timestamp, timestamp, recordId, user.institutionId),
      env.DB.prepare(
        "INSERT INTO audit (id,institution_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        makeId("audit"), user.institutionId, user.uid, "clinic.pharmacy.price.update",
        "pharmacy_inventory", recordId, JSON.stringify({ unitPrice }), timestamp,
      ),
    ]);
    const updated = (await list(env, user, "pharmacy_inventory")).find((row) => clean(row.id, 300) === recordId);
    return updated
      ? json({ ok: true, item: updated })
      : json({ ok: false, error: "Inventory item was not found after its price update" }, 404);
  }

  if (url.pathname === "/api/clinic/billing" && request.method === "GET") {
    if (!["clinic_admin", "receptionist", "patient", "superadmin"].includes(role)) return json({ ok: false, error: "Billing access required" }, 403);
    return json({ ok: true, records: await list(env, user, "billing"), payments: await manualPayments(env, user, role === "patient") });
  }

  if (url.pathname === "/api/clinic/billing" && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "superadmin"].includes(role)) return json({ ok: false, error: "Only billing staff can create bills" }, 403);
    const input = await parseBody(request);
    const patient = input ? await scopedPatient(env, user, clean(input.patientId, 300)) : null;
    const totalAmount = Number(input?.totalAmount);
    const description = clean(input?.description, 500);
    if (!input || !patient || !Number.isSafeInteger(totalAmount) || totalAmount <= 0 || !description) {
      return json({ ok: false, error: "A clinic patient, bill description, and positive whole-number UGX total are required" }, 400);
    }
    const timestamp = new Date().toISOString();
    const generatedId = makeId("bill");
    const bill = await save(env, user, "billing", {
      patientId: clean(patient.id, 300), patientName: clean(patient.fullName || patient.name, 160),
      invoiceNumber: `CL-${timestamp.slice(0, 10).replaceAll("-", "")}-${generatedId.slice(-6).toUpperCase()}`,
      billDate: timestamp.slice(0, 10), description, items: [{ description, amount: totalAmount }],
      total: totalAmount, totalAmount, amountPaid: 0, balanceRemaining: totalAmount,
      currency: "UGX", status: "unpaid", createdAt: timestamp, createdBy: user.uid,
    }, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
    return json({ ok: true, bill }, 201);
  }

  const billingPath = url.pathname.split("/");
  const billId = billingPath.length === 6 && billingPath[1] === "api" && billingPath[2] === "clinic"
    && billingPath[3] === "billing" ? decodeSegment(billingPath[4]) : "";
  if (billId && billingPath[5] === "payments" && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "superadmin"].includes(role)) return json({ ok: false, error: "Only billing staff can record payments" }, 403);
    const input = await parseBody(request);
    const amount = Number(input?.amount);
    const method = clean(input?.method, 32);
    const idempotencyKey = clean(input?.idempotencyKey, 180);
    if (!input || !Number.isSafeInteger(amount) || amount <= 0
      || !["cash", "mobile_money", "bank_transfer", "insurance"].includes(method) || !idempotencyKey) {
      return json({ ok: false, error: "A positive whole-number amount, manual payment method, and idempotency key are required" }, 400);
    }
    const bills = await list(env, user, "billing");
    const bill = bills.find((item) => clean(item.id, 300) === billId || clean(item.id, 300).endsWith(`/${billId}`));
    if (!bill) return json({ ok: false, error: "Bill not found in this clinic" }, 404);
    if (["paid", "reversed"].includes(clean(bill.status, 32).toLowerCase())) return json({ ok: false, error: "Paid or reversed bills cannot accept another payment" }, 409);
    const patientId = clean(bill.patientId, 300);
    const patient = await scopedPatient(env, user, patientId);
    if (!patient) return json({ ok: false, error: "Bill patient is not available in this clinic" }, 409);
    const prior = await env.DB.prepare(
      "SELECT id,bill_record_id AS billId,amount,method,created_at AS createdAt FROM clinic_manual_payments WHERE institution_id=? AND idempotency_key=? LIMIT 1",
    ).bind(user.institutionId, idempotencyKey).all<RecordData>();
    if (prior.results[0]) {
      if (clean(prior.results[0].billId, 300) !== clean(bill.id, 300)
        || Number(prior.results[0].amount) !== amount || clean(prior.results[0].method, 32) !== method) {
        return json({ ok: false, error: "This idempotency key was already used for a different payment" }, 409);
      }
      return json({ ok: true, payment: prior.results[0], idempotent: true });
    }
    const timestamp = new Date().toISOString();
    try {
      const stored = await env.DB.prepare(
        "SELECT id FROM sector_records WHERE id=? AND sector='clinic' AND institution_id=? AND record_type IN ('billing','clinic_billing') AND is_deleted=0 LIMIT 1",
      ).bind(clean(bill.id, 300), user.institutionId).all<RecordData>();
      if (!stored.results[0]) {
        await ensureStored(env, user, "billing", bill, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
      }
      await env.DB.prepare(
        `INSERT INTO clinic_manual_payments
          (id,institution_id,bill_record_id,patient_id,owner_uid,amount,method,reference,idempotency_key,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(makeId("clinic_payment"), user.institutionId, clean(bill.id, 300), patientId,
        clean(patient.patientUid || patient.userUid || patient.uid, 160) || null,
        amount, method, clean(input.reference, 160), idempotencyKey, user.uid, timestamp).run();
    } catch {
      const raced = await env.DB.prepare(
        "SELECT id,bill_record_id AS billId,amount,method,created_at AS createdAt FROM clinic_manual_payments WHERE institution_id=? AND idempotency_key=? LIMIT 1",
      ).bind(user.institutionId, idempotencyKey).all<RecordData>();
      if (raced.results[0]) {
        if (clean(raced.results[0].billId, 300) !== clean(bill.id, 300)
          || Number(raced.results[0].amount) !== amount || clean(raced.results[0].method, 32) !== method) {
          return json({ ok: false, error: "This idempotency key was already used for a different payment" }, 409);
        }
        return json({ ok: true, payment: raced.results[0], idempotent: true });
      }
      return json({ ok: false, error: "Payment was rejected; check the bill balance and try again" }, 409);
    }
    const updatedBill = (await list(env, user, "billing")).find((item) => clean(item.id, 300) === clean(bill.id, 300));
    await env.DB.prepare(
      "INSERT INTO audit (id,institution_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(makeId("audit"), user.institutionId, user.uid, "clinic.payment.record", "clinic_billing", clean(bill.id, 300), JSON.stringify({ amount, method }), timestamp).run();
    return json({ ok: true, bill: updatedBill || null, amount, currency: "UGX", gateway: false }, 201);
  }

  if (billId && billingPath[5] === "reverse" && request.method === "POST") {
    if (!["clinic_admin", "superadmin"].includes(role)) return json({ ok: false, error: "Only a Clinic Admin can reverse a paid bill" }, 403);
    const input = await parseBody(request);
    const reason = clean(input?.reason, 300);
    if (!reason) return json({ ok: false, error: "A reversal reason is required" }, 400);
    const bill = (await list(env, user, "billing")).find((item) => clean(item.id, 300) === billId || clean(item.id, 300).endsWith(`/${billId}`));
    if (!bill || clean(bill.status, 32).toLowerCase() !== "paid") return json({ ok: false, error: "Only a paid bill can be reversed" }, 409);
    const patient = await scopedPatient(env, user, clean(bill.patientId, 300));
    const reversed = await save(env, user, "billing", {
      ...bill, status: "reversed", reversedAt: new Date().toISOString(), reversalReason: reason,
    }, clean(patient?.patientUid || patient?.userUid || patient?.uid, 160) || null);
    return json({ ok: true, bill: reversed });
  }

  if (url.pathname === "/api/clinic/claims" && request.method === "GET") {
    if (!["clinic_admin", "receptionist", "patient", "superadmin"].includes(role)) return json({ ok: false, error: "Insurance-claim access required" }, 403);
    return json({ ok: true, records: await list(env, user, "insurance_claim") });
  }

  if (url.pathname === "/api/clinic/claims" && request.method === "POST") {
    if (!["clinic_admin", "receptionist", "superadmin"].includes(role)) return json({ ok: false, error: "Only clinic staff can submit insurance claims" }, 403);
    const input = await parseBody(request);
    const patient = input ? await scopedPatient(env, user, clean(input.patientId, 300)) : null;
    const claimAmount = Number(input?.claimAmount);
    const provider = clean(input?.provider, 120);
    if (!input || !patient || !provider || !Number.isSafeInteger(claimAmount) || claimAmount <= 0) {
      return json({ ok: false, error: "Patient, insurance provider, and positive whole-number claim amount are required" }, 400);
    }
    const billId = clean(input.billId, 300);
    if (billId) {
      const bill = (await list(env, user, "billing")).find((item) => clean(item.id, 300) === billId || clean(item.id, 300).endsWith(`/${billId}`));
      if (!bill || clean(bill.patientId, 300) !== clean(patient.id, 300)) {
        return json({ ok: false, error: "Related bill must belong to the selected patient in this clinic" }, 400);
      }
      const billBalance = Number(bill.balanceRemaining ?? bill.totalAmount ?? bill.total ?? 0);
      if (claimAmount > billBalance) return json({ ok: false, error: "Claim amount cannot exceed the related bill balance" }, 400);
    }
    const claim = await save(env, user, "insurance_claim", {
      patientId: clean(patient.id, 300), patientName: clean(patient.fullName || patient.name, 160),
      billId, provider, claimNumber: clean(input.claimNumber, 120),
      claimAmount, currency: "UGX", status: "Draft", createdAt: new Date().toISOString(), createdBy: user.uid,
    }, clean(patient.patientUid || patient.userUid || patient.uid, 160) || null);
    return json({ ok: true, claim }, 201);
  }

  const claimPath = url.pathname.split("/");
  const claimId = claimPath.length === 5 && claimPath[1] === "api" && claimPath[2] === "clinic"
    && claimPath[3] === "claims" ? decodeSegment(claimPath[4]) : "";
  if (claimId && request.method === "PATCH") {
    if (!["clinic_admin", "superadmin"].includes(role)) return json({ ok: false, error: "Only a Clinic Admin can review insurance claims" }, 403);
    const input = await parseBody(request);
    const nextStatus = clean(input?.status, 40);
    const allowedTransitions: Record<string, string[]> = {
      Draft: ["Submitted"],
      Submitted: ["Under Review"],
      "Under Review": ["Approved", "Partially Approved", "Rejected"],
      Approved: ["Paid"],
      "Partially Approved": ["Paid"],
    };
    const claim = (await list(env, user, "insurance_claim")).find((item) =>
      clean(item.id, 300) === claimId || clean(item.id, 300).endsWith(`/${claimId}`),
    );
    if (!claim) return json({ ok: false, error: "Insurance claim not found" }, 404);
    if (!allowedTransitions[clean(claim.status, 40)]?.includes(nextStatus)) {
      return json({ ok: false, error: "Invalid insurance-claim status transition" }, 409);
    }
    const patient = await scopedPatient(env, user, clean(claim.patientId, 300));
    const updated = await save(env, user, "insurance_claim", {
      ...claim, status: nextStatus, reviewedBy: user.uid, updatedAt: new Date().toISOString(),
    }, clean(patient?.patientUid || patient?.userUid || patient?.uid, 160) || null);
    return json({ ok: true, claim: updated });
  }

  if (url.pathname === "/api/clinic/reports" && request.method === "GET") {
    if (!["clinic_admin", "superadmin"].includes(role)) return json({ ok: false, error: "Clinic reporting access required" }, 403);
    const from = clean(url.searchParams.get("from"), 10);
    const to = clean(url.searchParams.get("to"), 10);
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from) || to && !/^\d{4}-\d{2}-\d{2}$/.test(to) || from && to && from > to) {
      return json({ ok: false, error: "Report dates must be valid ISO dates and From cannot be after To" }, 400);
    }
    const inRange = (value: unknown) => {
      const date = clean(value, 32).slice(0, 10);
      return (!from || date >= from) && (!to || date <= to);
    };
    const [appointments, visits, bills, inventory, claims, payments] = await Promise.all([
      list(env, user, "appointment"), list(env, user, "visit"), list(env, user, "billing"),
      list(env, user, "pharmacy_inventory"), list(env, user, "insurance_claim"), manualPayments(env, user, false),
    ]);
    const reversedBillIds = new Set(bills.filter((bill) => clean(bill.status, 32).toLowerCase() === "reversed").map((bill) => clean(bill.id, 300)));
    const filteredBills = bills.filter((bill) => inRange(bill.billDate || bill.createdAt) && clean(bill.status, 32).toLowerCase() !== "reversed");
    const filteredAppointments = appointments.filter((item) => inRange(item.appointmentDate || item.createdAt));
    const filteredVisits = visits.filter((item) => inRange(item.visitDate || item.createdAt));
    const filteredPayments = payments.filter((item) => inRange(item.createdAt) && !reversedBillIds.has(clean(item.billId, 300)));
    const peakHours: Record<string, number> = {};
    const doctors: Record<string, number> = {};
    for (const appointment of filteredAppointments) {
      const hour = clean(appointment.appointmentTime, 8).slice(0, 2);
      if (hour) peakHours[hour] = (peakHours[hour] || 0) + 1;
    }
    for (const visit of filteredVisits) {
      const doctor = clean(visit.doctorId, 160) || "Unassigned";
      doctors[doctor] = (doctors[doctor] || 0) + 1;
    }
    const revenueByDate: Record<string, number> = {};
    for (const payment of filteredPayments) {
      const day = clean(payment.createdAt, 32).slice(0, 10);
      revenueByDate[day] = (revenueByDate[day] || 0) + Number(payment.amount || 0);
    }
    return json({
      ok: true, range: { from: from || null, to: to || null },
      summary: {
        appointments: filteredAppointments.length, visits: filteredVisits.length,
        revenue: filteredPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
        bills: filteredBills.length, claims: claims.filter((claim) => inRange(claim.createdAt)).length,
        lowStock: inventory.filter((item) => Number(item.quantityInStock || 0) <= Number(item.lowStockThreshold || 0)).length,
      },
      revenueTrend: Object.entries(revenueByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount })),
      peakHours: Object.entries(peakHours).sort(([a], [b]) => a.localeCompare(b)).map(([hour, count]) => ({ hour, count })),
      doctorPerformance: Object.entries(doctors).map(([doctorId, visitCount]) => ({ doctorId, visitCount })),
    });
  }

  const prescriptionPath = url.pathname.split("/");
  const dispenseId = prescriptionPath.length === 6 && prescriptionPath[1] === "api"
    && prescriptionPath[2] === "clinic" && prescriptionPath[3] === "prescriptions"
    && prescriptionPath[5] === "dispense" ? prescriptionPath[4] : "";
  if (dispenseId && request.method === "POST") {
    if (!["clinic_admin", "pharmacist", "superadmin"].includes(role)) return json({ ok: false, error: "Only pharmacy staff can dispense prescriptions" }, 403);
    const prescription = (await list(env, user, "prescription")).find((row) =>
      clean(row.id, 300) === decodeSegment(dispenseId) || clean(row.id, 300).endsWith(`/${decodeSegment(dispenseId)}`),
    );
    if (!prescription) return json({ ok: false, error: "Prescription not found" }, 404);
    if (clean(prescription.status, 40) === "dispensed") return json({ ok: false, error: "Prescription has already been dispensed" }, 409);
    const patient = await scopedPatient(env, user, clean(prescription.patientId, 300));
    const existing = await env.DB.prepare(
      "SELECT id FROM sector_records WHERE id=? AND sector='clinic' AND institution_id=? AND record_type IN ('prescription','clinic_prescriptions') AND is_deleted=0 LIMIT 1",
    ).bind(clean(prescription.id, 300), user.institutionId).all<RecordData>();
    try {
      if (!existing.results[0]) {
        await save(env, user, "prescription", { ...prescription, status: "ready" }, clean(prescription.patientUid, 160) || null);
      }
      const updated = await save(env, user, "prescription", {
        ...prescription, status: "dispensed", dispensedAt: new Date().toISOString(), dispensedBy: user.uid,
      }, clean(patient?.patientUid || patient?.userUid || patient?.uid, 160) || null);
      return json({ ok: true, prescription: updated });
    } catch {
      return json({ ok: false, error: "Insufficient stock or no matching pharmacy item is available" }, 409);
    }
  }

  return null;
}