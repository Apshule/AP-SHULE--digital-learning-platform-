import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATABASE = "apshule-skills-db";
const confirmed = process.argv.includes("--confirm-production");

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
  const response = JSON.parse(wrangler([
    "d1", "execute", DATABASE, "--env", "production", "--remote", "--json", "--command", sql,
  ]));
  return response.flatMap((statement) => statement.results || []);
}

const firebaseUsers = `
  WITH firebase_users AS (
    SELECT substr(document_path, 7) AS uid,
      COALESCE(
        json_extract(data_json, '$.role.stringValue'),
        json_extract(data_json, '$.fields.role.stringValue'),
        CASE WHEN json_type(data_json, '$.role') = 'text' THEN json_extract(data_json, '$.role') END
      ) AS source_role,
      COALESCE(
        json_extract(data_json, '$.schoolId.stringValue'),
        json_extract(data_json, '$.school_id.stringValue'),
        json_extract(data_json, '$.fields.schoolId.stringValue'),
        json_extract(data_json, '$.fields.school_id.stringValue'),
        CASE WHEN json_type(data_json, '$.schoolId') = 'text' THEN json_extract(data_json, '$.schoolId') END,
        CASE WHEN json_type(data_json, '$.school_id') = 'text' THEN json_extract(data_json, '$.school_id') END
      ) AS source_school_id,
      COALESCE(
        json_extract(data_json, '$.institutionId.stringValue'),
        json_extract(data_json, '$.institution_id.stringValue'),
        json_extract(data_json, '$.fields.institutionId.stringValue'),
        json_extract(data_json, '$.fields.institution_id.stringValue'),
        CASE WHEN json_type(data_json, '$.institutionId') = 'text' THEN json_extract(data_json, '$.institutionId') END,
        CASE WHEN json_type(data_json, '$.institution_id') = 'text' THEN json_extract(data_json, '$.institution_id') END
      ) AS source_institution_id
    FROM firestore_documents
    WHERE collection_path = 'users' AND document_path LIKE 'users/%'
  )
`;

function audit() {
  return query(`${firebaseUsers}
    SELECT COUNT(*) AS total_users,
      SUM(CASE WHEN trim(COALESCE(users.role, '')) = '' THEN 1 ELSE 0 END) AS blank_roles,
      SUM(CASE WHEN trim(COALESCE(users.role, '')) = ''
        AND NULLIF(trim(firebase_users.source_role), '') IS NULL THEN 1 ELSE 0 END) AS roles_to_default_to_student,
      SUM(CASE WHEN NULLIF(trim(firebase_users.source_school_id), '') IS NOT NULL THEN 1 ELSE 0 END) AS source_school_scopes,
      SUM(CASE WHEN NULLIF(trim(firebase_users.source_institution_id), '') IS NOT NULL THEN 1 ELSE 0 END) AS source_institution_scopes
    FROM users
    LEFT JOIN firebase_users ON firebase_users.uid = users.uid
  `)[0];
}

const before = audit();
if (!before) throw new Error("Could not audit production user rows.");
console.log(`Preflight: ${JSON.stringify(before)}`);
console.log("Existing nonblank roles are preserved. Missing roles default to student; only source-backed school/institution IDs are copied.");

if (!confirmed) {
  console.log("Dry run only. Pass --confirm-production to apply this backfill.");
  process.exit(0);
}

const update = `${firebaseUsers}
  UPDATE users
  SET role = CASE
        WHEN trim(COALESCE(users.role, '')) = '' THEN COALESCE(
          (SELECT NULLIF(trim(source_role), '') FROM firebase_users WHERE firebase_users.uid = users.uid),
          'student'
        )
        ELSE users.role
      END,
      school_id = COALESCE(
        users.school_id,
        (SELECT NULLIF(trim(source_school_id), '') FROM firebase_users WHERE firebase_users.uid = users.uid)
      ),
      institution_id = COALESCE(
        users.institution_id,
        (SELECT NULLIF(trim(source_institution_id), '') FROM firebase_users WHERE firebase_users.uid = users.uid)
      )
  WHERE trim(COALESCE(users.role, '')) = ''
     OR (users.school_id IS NULL AND EXISTS (
       SELECT 1 FROM firebase_users
       WHERE firebase_users.uid = users.uid
         AND NULLIF(trim(source_school_id), '') IS NOT NULL
     ))
     OR (users.institution_id IS NULL AND EXISTS (
       SELECT 1 FROM firebase_users
       WHERE firebase_users.uid = users.uid
         AND NULLIF(trim(source_institution_id), '') IS NOT NULL
     ))
`;
wrangler([
  "d1", "execute", DATABASE, "--env", "production", "--remote", "--command", update,
]);

const after = audit();
if (!after || Number(after.blank_roles) !== 0) {
  throw new Error("Backfill ran, but blank-role verification did not pass.");
}
console.log(`Verified: ${JSON.stringify(after)}`);
for (const row of query("SELECT role,COUNT(*) AS users FROM users GROUP BY role ORDER BY role")) {
  console.log(`${row.role || "<blank>"}: ${row.users}`);
}