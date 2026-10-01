import type { AuthEnv, AuthUser } from "./backend-types";

export type DbRow = Record<string, unknown>;

export interface PlatformR2Bucket {
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete?(key: string): Promise<unknown>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded?: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface PlatformV10Env extends AuthEnv {
  FILES?: PlatformR2Bucket;
}

export const platformJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
});

export const cleanText = (value: unknown, max = 240) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export const normalizedRole = (user: AuthUser) =>
  cleanText(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");

export const isPlatformSuperadmin = (user: AuthUser) =>
  ["superadmin", "super_admin"].includes(normalizedRole(user));

export const userTenantId = (user: AuthUser) => user.schoolId || user.institutionId || "";

export function mayAccessInstitution(user: AuthUser, institutionId: string) {
  return isPlatformSuperadmin(user) ||
    institutionId === user.schoolId ||
    institutionId === user.institutionId;
}

export function canManageTimetable(user: AuthUser) {
  return [
    "superadmin", "super_admin", "school", "school_admin", "head_teacher",
    "headteacher", "secretary", "education_admin",
  ].includes(normalizedRole(user));
}

export function database(env: PlatformV10Env) {
  if (!env.PG) throw new Error("Neon database persistence is unavailable");
  return env.PG;
}

export async function readJson(request: Request): Promise<DbRow> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as DbRow : {};
  } catch {
    return {};
  }
}

export function parseJsonObject(value: unknown): DbRow {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as DbRow;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as DbRow : {};
  } catch {
    return {};
  }
}

export function safeId(value: unknown, max = 180) {
  const id = cleanText(value, max);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : "";
}

export function safeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function jsonAttachment(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(arrayBufferOf(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function pdfEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
    .replace(/[^\x20-\x7e]/g, "?");
}

export function makeSimplePdf(title: string, lines: string[]) {
  const pageLines = [title, ...lines].slice(0, 42);
  const commands = ["BT", "/F1 14 Tf", "48 552 Td", `(${pdfEscape(pageLines[0] || "APSHULE report")}) Tj`, "/F1 9 Tf"];
  for (const line of pageLines.slice(1)) {
    commands.push("0 -13 Td", `(${pdfEscape(line.slice(0, 150))}) Tj`);
  }
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(output).length);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(output).length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(output);
}

function crc32(bytes: Uint8Array) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

export function makeStoredZip(entries: Array<{ name: string; bytes: Uint8Array }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const viewBuffer = (size: number) => new Uint8Array(size);
  for (const entry of entries) {
    const name = encoder.encode(entry.name.slice(0, 240));
    const data = entry.bytes;
    const crc = crc32(data);
    const local = viewBuffer(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = viewBuffer(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = viewBuffer(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  const parts = [...localParts, ...centralParts, end];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}