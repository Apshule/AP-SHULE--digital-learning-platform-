import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATABASE = "apshule-skills-db";

if (!process.argv.includes("--confirm-production")) {
  throw new Error("Pass --confirm-production to run this insert-only production import.");
}

function wrangler(args) {
  try {
    return execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Wrangler failed; no source values were printed.");
  }
}

function query(sql) {
  let response;
  try {
    response = JSON.parse(wrangler([
      "d1", "execute", DATABASE, "--env", "production", "--remote", "--json", "--command", sql,
    ]));
  } catch {
    throw new Error("Could not read the D1 Firestore mirror.");
  }
  return response.flatMap((statement) => statement.results || []);
}

function decodeFirestore(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeFirestore);
  if ("fields" in value) return decodeFirestore(value.fields);
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("referenceValue" in value) return value.referenceValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) return ((value.arrayValue || {}).values || []).map(decodeFirestore);
  if ("mapValue" in value) return decodeFirestore((value.mapValue || {}).fields || {});
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "__proto__")
      .map(([key, child]) => [key, decodeFirestore(child)]),
  );
}

const sensitiveKey = /password|token|secret|credential|cookie|signature|parentsig|studentsig|apikey|privatekey|hash/i;
function sanitize(value) {
  if (typeof value === "string") return value.replace(/\0/g, "");
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "__proto__" && !sensitiveKey.test(key))
      .map(([key, child]) => [key, sanitize(child)]),
  );
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function text(value, max = 300) {
  if (value === null || value === undefined || typeof value === "object" || typeof value === "boolean") return "";
  return String(value).replace(/\0/g, "").trim().slice(0, max);
}

function timestamp(value, fallback) {
  return text(value, 100) || text(fallback, 100) || new Date().toISOString();
}

function statementUpdateAdmissions(record, source, type) {
  const data = sanitize(decodeFirestore(JSON.parse(source.data_json)));
  const id = source.document_path;
  const createdAt = timestamp(data.createdAt || data.submittedAt, source.create_time || source.update_time);
  const updatedAt = timestamp(source.update_time, source.create_time);

  if (type === "school") {
    const schoolId = text(record.school_id || source.singleSchoolId, 200);
    if (!schoolId) return null;
    const studentId = text(data.studentUid || data.studentId, 200);
    const fullName = text(data.fullName || data.studentName, 200);
    const phone = text(data.guardianPhone || data.fatherPhone || data.motherPhone, 100);
    const email = text(data.studentEmail || data.email, 320);
    const educationLevel = text(data.class || data.className, 120);
    const previousExperience = text(data.prevSchool || data.previousSchool, 240);
    const payload = {
      ...data, id, type: "school", recordType: "admission",
      schoolId, institutionId: null,
    };
    const values = [
      studentId, fullName, phone, email, educationLevel, previousExperience,
      schoolId, JSON.stringify(payload), createdAt, updatedAt, id,
    ].map(sql);
    return `UPDATE school_admissions SET student_id=${values[0]},full_name=${values[1]},phone=${values[2]},email=${values[3]},education_level=${values[4]},previous_experience=${values[5]},school_id=${values[6]},record_json=${values[7]},created_at=${values[8]},updated_at=${values[9]} WHERE id=${values[10]} AND json_type(record_json,'$.fullName')='object';\n`
      + `INSERT OR IGNORE INTO school_admissions (id,student_id,full_name,phone,email,education_level,previous_experience,school_id,record_json,created_by,is_deleted,created_at,updated_at) VALUES (${[
        id, studentId, fullName, phone, email, educationLevel, previousExperience,
        schoolId, JSON.stringify(payload), "firestore-import", 0, createdAt, updatedAt,
      ].map(sql).join(",")});`;
  }

  const providerId = text(data.providerId, 200);
  const courseId = text(data.courseId, 200);
  const studentId = text(data.studentId, 200);
  const fullName = text(data.studentName || data.fullName || data.displayName, 200);
  const email = text(data.studentEmail || data.email, 320);
  const amount = Number(data.amountUgx ?? data.amount ?? 0);
  const status = text(data.status, 80) || "pending";
  const payload = { ...data, id, type: "vocational" };
  const values = [
    providerId, courseId, text(data.referralCode, 120), studentId, fullName,
    email, Number.isFinite(amount) ? Math.round(amount) : 0, status,
    JSON.stringify(payload), createdAt, updatedAt, id,
  ].map(sql);
  return `UPDATE vocational_enrollments SET provider_id=${values[0]},course_id=${values[1]},referral_code=${values[2]},student_id=${values[3]},full_name=${values[4]},email=${values[5]},amount_ugx=${values[6]},status=${values[7]},record_json=${values[8]},created_at=${values[9]},updated_at=${values[10]} WHERE id=${values[11]} AND (json_type(record_json,'$.providerId')='object' OR json_type(record_json,'$.studentId')='object');\n`
    + `INSERT OR IGNORE INTO vocational_enrollments (id,provider_id,course_id,referral_code,student_id,full_name,phone,email,education_level,previous_experience,amount_ugx,payment_reference,payment_status,status,record_json,is_deleted,created_at,updated_at) VALUES (${[
      id, providerId, courseId, text(data.referralCode, 120),
      studentId, fullName, "", email, "", "", Number.isFinite(amount) ? Math.round(amount) : 0,
      "", "pending", status, JSON.stringify(payload), 0, createdAt, updatedAt,
    ].map(sql).join(",")});`;
}

const sources = query(
  "SELECT document_path,collection_path,data_json,create_time,update_time FROM firestore_documents " +
  "WHERE collection_path IN ('schools','subjects','institutions','admissionForms','skills_enrollments','clinic_branches','clinic_services','farms','mfi_branches','mfi_collateral_types','mfi_legal_officers','mfi_loan_products','mfi_valuers')",
);
const byCollection = new Map();
for (const source of sources) {
  const list = byCollection.get(source.collection_path) || [];
  list.push(source);
  byCollection.set(source.collection_path, list);
}
const schools = byCollection.get("schools") || [];
const singleSchoolId = schools.length === 1
  ? text(schools[0].document_path.split("/").slice(1).join("/"), 200)
  : "";
const mfiInstitutionDocs = (byCollection.get("institutions") || []).filter((row) => {
  const data = sanitize(decodeFirestore(JSON.parse(row.data_json)));
  return text(data.type, 80).toLowerCase() === "mfi";
});
const singleMfiInstitutionId = mfiInstitutionDocs.length === 1
  ? text(mfiInstitutionDocs[0].document_path.split("/").slice(1).join("/"), 200)
  : "";

const admissionIds = [
  ...(byCollection.get("admissionForms") || []),
  ...(byCollection.get("skills_enrollments") || []),
].map((row) => sql(row.document_path)).join(",");
const existingAdmissions = admissionIds
  ? query(`SELECT id,school_id,'school' AS type FROM school_admissions WHERE id IN (${admissionIds})`)
  : [];
const existingById = new Map(existingAdmissions.map((row) => [row.id, row]));

const statements = [];
let schoolAdmissions = 0;
let vocationalEnrollments = 0;
let scopedReferenceRecords = 0;
let skippedUnscopedRecords = 0;

for (const source of byCollection.get("admissionForms") || []) {
  source.singleSchoolId = singleSchoolId;
  const statement = statementUpdateAdmissions(existingById.get(source.document_path) || {}, source, "school");
  if (statement) { statements.push(statement); schoolAdmissions += 1; }
  else skippedUnscopedRecords += 1;
}
for (const source of byCollection.get("skills_enrollments") || []) {
  const statement = statementUpdateAdmissions(existingById.get(source.document_path) || {}, source, "vocational");
  if (statement) { statements.push(statement); vocationalEnrollments += 1; }
}

const referenceTypes = {
  subjects: ["education", "subject"],
  clinic_branches: ["clinic", "branch"],
  clinic_services: ["clinic", "service"],
  farms: ["farm", "farm"],
  mfi_branches: ["mfi", "branch"],
  mfi_collateral_types: ["mfi", "collateral_type"],
  mfi_legal_officers: ["mfi", "legal_officer"],
  mfi_loan_products: ["mfi", "loan_product"],
  mfi_valuers: ["mfi", "valuer"],
};
for (const [collection, [sector, recordType]] of Object.entries(referenceTypes)) {
  for (const source of byCollection.get(collection) || []) {
    const data = sanitize(decodeFirestore(JSON.parse(source.data_json)));
    const institutionId = text(
      data.institutionId || data.institution_id ||
        (sector === "farm" && data.farmId) ||
        (collection === "mfi_collateral_types" ? singleMfiInstitutionId : ""),
      200,
    ) || null;
    const schoolId = text(
      data.schoolId || data.school_id || (collection === "subjects" ? singleSchoolId : ""),
      200,
    ) || null;
    if (!institutionId && !schoolId) { skippedUnscopedRecords += 1; continue; }
    const id = source.document_path;
    const payload = { ...data, id, recordType, institutionId, schoolId };
    const createdAt = timestamp(data.createdAt, source.create_time || source.update_time);
    const updatedAt = timestamp(data.updatedAt, source.update_time || source.create_time);
    const values = [
      institutionId, schoolId, JSON.stringify(payload), createdAt, updatedAt,
      id, sector, recordType,
    ].map(sql);
    statements.push(
      `UPDATE sector_records SET institution_id=${values[0]},school_id=${values[1]},record_json=${values[2]},created_at=${values[3]},updated_at=${values[4]} WHERE id=${values[5]} AND sector=${values[6]} AND record_type=${values[7]} AND created_by='firestore-import' AND (substr(institution_id,1,1)='{' OR institution_id='false' OR school_id='false');\n` +
      `INSERT OR IGNORE INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at) VALUES (${[
        id, sector, institutionId, schoolId, null, recordType, JSON.stringify(payload),
        "firestore-import", 0, createdAt, updatedAt,
      ].map(sql).join(",")});`,
    );
    scopedReferenceRecords += 1;
  }
}

if (statements.length) {
  const directory = mkdtempSync(join(tmpdir(), "apshule-firestore-import-"));
  const file = join(directory, "import.sql");
  try {
    writeFileSync(file, statements.join("\n"), { mode: 0o600 });
    wrangler(["d1", "execute", DATABASE, "--env", "production", "--remote", "--file", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  schoolAdmissions,
  vocationalEnrollments,
  scopedReferenceRecords,
  skippedUnscopedRecords,
  userRowsChanged: 0,
  rawFirestoreDocumentsChanged: 0,
}));