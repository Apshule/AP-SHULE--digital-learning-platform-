import type { AuthUser } from "./backend-types";
import {
  cleanText,
  database,
  isPlatformSuperadmin,
  parseJsonObject,
  platformJson,
  PlatformV10Env,
  readJson,
  safeId,
} from "./platform-v10-common";

const TYPES = new Set(["school", "mfi", "clinic", "farm"]);
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
type Row = Record<string, unknown>;

interface InstitutionInput {
  data: Row;
  logo: File | null;
  decodedLogo?: { bytes: Uint8Array; type: string };
  invalidLogo?: boolean;
}

function isInstitutionManager(user: AuthUser) {
  const role = cleanText(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  return isPlatformSuperadmin(user) || [
    "school", "school_admin", "head_teacher", "headteacher", "secretary",
    "mfi_admin", "clinic_admin", "farm_admin", "institution_admin",
  ].includes(role);
}

function mayManage(user: AuthUser, institutionId: string) {
  return isPlatformSuperadmin(user) ||
    (isInstitutionManager(user) && (institutionId === user.institutionId || institutionId === user.schoolId));
}

function imageType(bytes: Uint8Array, claimed: string) {
  if (claimed === "image/png" && bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (claimed === "image/jpeg" && bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (claimed === "image/webp" && bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}

function bytesFromDataUrl(value: string) {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s/g, ""));
    if (binary.length > MAX_LOGO_BYTES) return null;
    return { bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)), type: match[1] };
  } catch {
    return null;
  }
}

async function readInstitutionInput(request: Request): Promise<InstitutionInput> {
  if (request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
    const form = await request.formData();
    const data: Row = {};
    for (const key of ["name", "type", "contact", "contact_phone", "email", "address", "district", "subdomain"]) {
      const value = form.get(key);
      if (typeof value === "string") data[key] = value;
    }
    const branding = form.get("branding_config");
    if (typeof branding === "string") {
      try { data.branding_config = JSON.parse(branding); } catch { data.branding_config = {}; }
    }
    const logoValue = form.get("logo");
    return { data, logo: logoValue instanceof File && logoValue.size > 0 ? logoValue : null };
  }
  const data = await readJson(request);
  if (typeof data.logo !== "string" || !data.logo.startsWith("data:")) return { data, logo: null };
  const decoded = bytesFromDataUrl(data.logo);
  if (!decoded) return { data: {}, logo: null, invalidLogo: true };
  return { data, logo: null, decodedLogo: decoded };
}

async function uploadLogo(env: PlatformV10Env, institutionId: string, input: InstitutionInput) {
  if (!input.logo && !input.decodedLogo) return { objectKey: "", logoUrl: "" };
  if (!env.FILES) throw new Error("r2_unavailable");
  let bytes: Uint8Array;
  let claimedType: string;
  if (input.logo) {
    if (input.logo.size > MAX_LOGO_BYTES) throw new Error("logo_too_large");
    bytes = new Uint8Array(await input.logo.arrayBuffer());
    claimedType = input.logo.type;
  } else {
    bytes = input.decodedLogo!.bytes;
    claimedType = input.decodedLogo!.type;
  }
  const contentType = imageType(bytes, claimedType);
  if (!contentType) throw new Error("logo_type_invalid");
  const digestInput = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  const objectKey = `institutions/${institutionId}/logo-${sha.slice(0, 24)}.${extension}`;
  await env.FILES.put(objectKey, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    httpMetadata: { contentType },
  });
  return {
    objectKey,
    logoUrl: `/api/institutions/${encodeURIComponent(institutionId)}/logo?v=${sha.slice(0, 12)}`,
  };
}

async function listInstitutions(request: Request, env: PlatformV10Env, user: AuthUser) {
  const url = new URL(request.url);
  const type = cleanText(url.searchParams.get("type"), 20).toLowerCase();
  const listAll = url.searchParams.get("all") === "true";
  if (type && !TYPES.has(type)) return platformJson({ ok: false, error: "type must be school, mfi, clinic, or farm" }, 400);
  if (listAll && !isPlatformSuperadmin(user)) return platformJson({ ok: false, error: "Only a Super Admin can list all institutions" }, 403);
  if (!type && !listAll) return platformJson({ ok: false, error: "Specify a type or use all=true as a Super Admin" }, 400);
  if (!isPlatformSuperadmin(user) && !user.institutionId && !user.schoolId) {
    return platformJson({ ok: false, error: "An institution account is required" }, 403);
  }
  const values: unknown[] = [];
  let where = "";
  if (type) {
    values.push(type);
    where += ` WHERE type=$${values.length}`;
  }
  if (!isPlatformSuperadmin(user)) {
    values.push(user.institutionId || user.schoolId);
    where += `${where ? " AND" : " WHERE"} (id=$${values.length} OR id=$${values.length + 1})`;
    values.push(user.schoolId || user.institutionId);
  }
  const result = await database(env).query<Row>(
    `SELECT id,name,type,logo_url,subdomain,contact_phone,email,address,district,branding_config,created_at,updated_at
       FROM public.institutions${where} ORDER BY name LIMIT 500`,
    values,
  );
  return platformJson({ ok: true, institutions: result.rows });
}

async function createInstitution(request: Request, env: PlatformV10Env, user: AuthUser) {
  if (!isPlatformSuperadmin(user)) return platformJson({ ok: false, error: "Only a Super Admin can create institutions" }, 403);
  const input = await readInstitutionInput(request);
  if (input.invalidLogo) return platformJson({ ok: false, error: "Institution logo must be valid base64 PNG, JPEG, or WebP" }, 400);
  const name = cleanText(input.data.name, 180);
  const type = cleanText(input.data.type, 20).toLowerCase();
  if (!name || !TYPES.has(type)) return platformJson({ ok: false, error: "A name and valid institution type are required" }, 400);
  const id = safeId(input.data.id, 120) || `institution_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let uploaded: { objectKey: string; logoUrl: string };
  try {
    uploaded = await uploadLogo(env, id, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "logo_too_large") return platformJson({ ok: false, error: "Institution logos must be 5 MiB or smaller" }, 413);
    if (message === "logo_type_invalid") return platformJson({ ok: false, error: "Institution logos must be valid PNG, JPEG, or WebP images" }, 415);
    if (message === "r2_unavailable") return platformJson({ ok: false, error: "R2 logo storage is unavailable" }, 503);
    return platformJson({ ok: false, error: "Institution logo could not be stored" }, 502);
  }
  const timestamp = new Date().toISOString();
  try {
    await database(env).query(
      `INSERT INTO public.institutions
        (id,name,type,logo_url,logo_object_key,subdomain,contact_phone,email,address,district,branding_config,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12)`,
      [
        id, name, type, uploaded.logoUrl, uploaded.objectKey,
        cleanText(input.data.subdomain, 180), cleanText(input.data.contact_phone || input.data.contact, 40),
        cleanText(input.data.email, 180).toLowerCase(), cleanText(input.data.address, 240),
        cleanText(input.data.district, 120), JSON.stringify(parseJsonObject(input.data.branding_config)), timestamp,
      ],
    );
  } catch {
    if (uploaded.objectKey) {
      try { await env.FILES?.delete?.(uploaded.objectKey); } catch { /* Leave the safe generic write failure. */ }
    }
    return platformJson({ ok: false, error: "Institution could not be saved" }, 503);
  }
  return platformJson({
    ok: true,
    institution: {
      id, name, type, logo_url: uploaded.logoUrl, subdomain: cleanText(input.data.subdomain, 180),
      contact_phone: cleanText(input.data.contact_phone || input.data.contact, 40),
      email: cleanText(input.data.email, 180).toLowerCase(), address: cleanText(input.data.address, 240),
      district: cleanText(input.data.district, 120),
    },
  }, 201);
}

async function updateInstitution(request: Request, env: PlatformV10Env, user: AuthUser, institutionId: string) {
  if (!mayManage(user, institutionId)) return platformJson({ ok: false, error: "You cannot update this institution" }, 403);
  const input = await readInstitutionInput(request);
  if (input.invalidLogo) return platformJson({ ok: false, error: "Institution logo must be valid base64 PNG, JPEG, or WebP" }, 400);
  const name = input.data.name === undefined ? null : cleanText(input.data.name, 180);
  const type = input.data.type === undefined ? null : cleanText(input.data.type, 20).toLowerCase();
  const subdomain = input.data.subdomain === undefined ? null : cleanText(input.data.subdomain, 180).toLowerCase();
  const contactPhone = input.data.contact_phone === undefined && input.data.contact === undefined
    ? null : cleanText(input.data.contact_phone ?? input.data.contact, 40);
  const email = input.data.email === undefined ? null : cleanText(input.data.email, 180).toLowerCase();
  const address = input.data.address === undefined ? null : cleanText(input.data.address, 240);
  const district = input.data.district === undefined ? null : cleanText(input.data.district, 120);
  const branding = input.data.branding_config === undefined ? null : parseJsonObject(input.data.branding_config);
  if (name !== null && !name) return platformJson({ ok: false, error: "Institution name cannot be empty" }, 400);
  if (type !== null && !TYPES.has(type)) return platformJson({ ok: false, error: "type must be school, mfi, clinic, or farm" }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return platformJson({ ok: false, error: "Institution email is invalid" }, 400);
  if (input.data.logo_url !== undefined) {
    const requestedLogo = cleanText(input.data.logo_url, 500);
    const expectedLogoRoute = `/api/institutions/${encodeURIComponent(institutionId)}/logo`;
    const version = requestedLogo.startsWith(`${expectedLogoRoute}?v=`)
      ? requestedLogo.slice(`${expectedLogoRoute}?v=`.length)
      : "";
    if (requestedLogo && requestedLogo !== expectedLogoRoute && !/^[a-f0-9]{12}$/.test(version)) {
      return platformJson({ ok: false, error: "Use the institution logo upload instead of an external URL" }, 400);
    }
  }
  if (branding && branding.header !== undefined && !["dual", "single"].includes(String(branding.header))) {
    return platformJson({ ok: false, error: "branding_config.header must be dual or single" }, 400);
  }
  let uploadedObjectKey: string | null = null;
  if (input.logo || input.decodedLogo) {
    try {
      const uploaded = await uploadLogo(env, institutionId, input);
      uploadedObjectKey = uploaded.objectKey;
      input.data.logo_object_key = uploaded.objectKey;
      input.data.logo_url = uploaded.logoUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return platformJson({
        ok: false,
        error: message === "logo_too_large" ? "Institution logos must be 5 MiB or smaller"
          : message === "r2_unavailable" ? "R2 logo storage is unavailable"
            : message === "logo_type_invalid" ? "Institution logos must be valid PNG, JPEG, or WebP images"
              : "Institution logo could not be stored",
      }, message === "logo_too_large" ? 413 : message === "logo_type_invalid" ? 415 : 503);
    }
  }
  let result;
  try {
    result = await database(env).query<Row>(
    `UPDATE public.institutions SET
       name=COALESCE($2,name),
       type=COALESCE($3,type),
       subdomain=COALESCE($4,subdomain),
       contact_phone=COALESCE($5,contact_phone),
       email=COALESCE($6,email),
       address=COALESCE($7,address),
       district=COALESCE($8,district),
       logo_url=COALESCE($9,logo_url),
        logo_object_key=COALESCE($10,logo_object_key),
       branding_config=COALESCE($11::jsonb,branding_config),
       updated_at=NOW()
     WHERE id=$1 RETURNING id,name,type,logo_url,subdomain,contact_phone,email,address,district,branding_config,updated_at`,
    [
      institutionId, name, type, subdomain, contactPhone, email, address, district,
      input.data.logo_url === undefined ? null : cleanText(input.data.logo_url, 500),
       uploadedObjectKey,
      branding === null ? null : JSON.stringify(branding),
    ],
    );
  } catch {
    if (uploadedObjectKey) {
      try { await env.FILES?.delete?.(uploadedObjectKey); } catch { /* Preserve the sanitized database error. */ }
    }
    return platformJson({ ok: false, error: "Institution could not be updated" }, 503);
  }
  if (!result.rows[0]) {
    if (uploadedObjectKey) {
      try { await env.FILES?.delete?.(uploadedObjectKey); } catch { /* Preserve the not-found result. */ }
    }
    return platformJson({ ok: false, error: "Institution not found" }, 404);
  }
  return platformJson({ ok: true, institution: result.rows[0] });
}

async function getBranding(env: PlatformV10Env, institutionId: string) {
  const result = await database(env).query<Row>(
    "SELECT id,name,type,logo_url,subdomain,contact_phone,email,branding_config FROM public.institutions WHERE id=$1 LIMIT 1",
    [institutionId],
  );
  const institution = result.rows[0];
  if (!institution) return platformJson({ ok: false, error: "Institution not found" }, 404);
  const config = parseJsonObject(institution.branding_config);
  const subdomain = cleanText(institution.subdomain, 180).toLowerCase();
  const isTech = subdomain.includes("/tech/") || subdomain === "tech" || subdomain.startsWith("tech.");
  const phone = cleanText(institution.contact_phone, 40);
  const wa = phone.replace(/\D/g, "");
  return platformJson({
    ok: true,
    id: institution.id,
    name: institution.name,
    apshule_logo: "/logo.png",
    institution_logo: cleanText(institution.logo_url, 500),
    header: config.header === "single" ? "single" : "dual",
    header_mode: isTech ? "Shule-Tech 0794221315 shuletech15@gmail.com" : "APSHULE +256731038702",
    footer: {
      col1: cleanText(parseJsonObject(config.footer).col1, 500),
      col2: cleanText(parseJsonObject(config.footer).col2, 500),
    },
    whatsapp: wa ? `https://wa.me/${wa}` : "https://wa.me/256731038702",
  });
}

async function getLogo(env: PlatformV10Env, institutionId: string) {
  if (!env.FILES) return platformJson({ ok: false, error: "R2 logo storage is unavailable" }, 503);
  const result = await database(env).query<Row>(
    "SELECT logo_object_key FROM public.institutions WHERE id=$1 LIMIT 1",
    [institutionId],
  );
  const key = cleanText(result.rows[0]?.logo_object_key, 500);
  if (!key) return platformJson({ ok: false, error: "Institution logo not found" }, 404);
  if (!key.startsWith(`institutions/${institutionId}/`)) {
    return platformJson({ ok: false, error: "Institution logo is not stored in its own R2 scope" }, 409);
  }
  const object = await env.FILES.get(key);
  if (!object) return platformJson({ ok: false, error: "Institution logo not found in R2" }, 404);
  const contentType = object.httpMetadata?.contentType;
  if (contentType !== "image/png" && contentType !== "image/jpeg" && contentType !== "image/webp") {
    return platformJson({ ok: false, error: "Institution logo has an unsupported image type" }, 415);
  }
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

async function listInstitutionUsers(env: PlatformV10Env, user: AuthUser, institutionId: string) {
  if (!mayManage(user, institutionId)) return platformJson({ ok: false, error: "You cannot view users for this institution" }, 403);
  const result = await database(env).query<Row>(
    `SELECT uid,email,display_name,role,institution_id,school_id,created_at
       FROM public.users
      WHERE institution_id=$1 OR school_id=$1
      ORDER BY role,display_name LIMIT 1000`,
    [institutionId],
  );
  return platformJson({ ok: true, users: result.rows });
}

export async function handleInstitutionsV10Route(
  request: Request,
  env: PlatformV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/institutions")) return null;
  const publicBrand = url.pathname.match(/^\/api\/institutions\/([^/]+)\/branding$/);
  const publicLogo = url.pathname.match(/^\/api\/institutions\/([^/]+)\/logo$/);
  if (url.pathname !== "/api/institutions" && !publicBrand && !publicLogo &&
      !/^\/api\/institutions\/[^/]+(?:\/users)?$/.test(url.pathname)) return null;
  if (publicBrand && request.method === "GET") {
    if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
    try { return await getBranding(env, safeId(decodeURIComponent(publicBrand[1]), 180)); }
    catch { return platformJson({ ok: false, error: "Institution branding is unavailable" }, 503); }
  }
  if (publicLogo && request.method === "GET") {
    if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
    try { return await getLogo(env, safeId(decodeURIComponent(publicLogo[1]), 180)); }
    catch { return platformJson({ ok: false, error: "Institution logo is unavailable" }, 503); }
  }
  if (!user) return platformJson({ ok: false, error: "Authentication is required" }, 401);
  if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== url.origin) {
    return platformJson({ ok: false, error: "Cross-origin requests are not allowed" }, 403);
  }
  try {
    if (url.pathname === "/api/institutions") {
      if (request.method === "GET") return await listInstitutions(request, env, user);
      if (request.method === "POST") return await createInstitution(request, env, user);
      return platformJson({ ok: false, error: "Method not allowed" }, 405);
    }
    const usersMatch = url.pathname.match(/^\/api\/institutions\/([^/]+)\/users$/);
    if (usersMatch && request.method === "GET") {
      return await listInstitutionUsers(env, user, safeId(decodeURIComponent(usersMatch[1]), 180));
    }
    const institutionMatch = url.pathname.match(/^\/api\/institutions\/([^/]+)$/);
    if (!institutionMatch) return platformJson({ ok: false, error: "Institution route not found" }, 404);
    const institutionId = safeId(decodeURIComponent(institutionMatch[1]), 180);
    if (request.method === "GET") {
      if (!mayManage(user, institutionId)) return platformJson({ ok: false, error: "You cannot view this institution" }, 403);
      const result = await database(env).query<Row>(
        `SELECT id,name,type,logo_url,subdomain,contact_phone,email,address,district,branding_config,created_at,updated_at
           FROM public.institutions WHERE id=$1 LIMIT 1`,
        [institutionId],
      );
      return result.rows[0]
        ? platformJson({ ok: true, institution: result.rows[0] })
        : platformJson({ ok: false, error: "Institution not found" }, 404);
    }
    if (request.method === "PUT") return await updateInstitution(request, env, user, institutionId);
    return platformJson({ ok: false, error: "Method not allowed" }, 405);
  } catch {
    return platformJson({ ok: false, error: "Institution request could not be completed" }, 503);
  }
}