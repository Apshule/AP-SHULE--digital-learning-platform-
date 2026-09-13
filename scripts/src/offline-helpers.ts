/** Pure helpers shared by offline-manager tests and integrations. */
export type ConnectionMode = "offline" | "mobile" | "wifi";

export function detectConnectionMode(
  online: boolean,
  connection?: { type?: string; effectiveType?: string },
  savedFallback?: ConnectionMode,
): ConnectionMode {
  if (!online) return "offline";
  const type = (connection?.type ?? "").toLowerCase();
  const effective = (connection?.effectiveType ?? "").toLowerCase();
  if (type === "cellular" || /(^|-)2g|(^|-)3g/.test(effective)) return "mobile";
  if (type === "wifi" || effective.includes("4g")) return "wifi";
  return savedFallback ?? "offline";
}

export function isCacheEligibleUrl(
  value: string,
  origin: string,
  firebaseStorageHosts = [
    "firebasestorage.googleapis.com",
    "storage.googleapis.com",
    "appshule-app.firebasestorage.app",
  ],
): boolean {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    /(^|\.)youtube\.com$/.test(host) ||
    /(^|\.)youtu\.be$/.test(host) ||
    /(^|\.)youtube-nocookie\.com$/.test(host) ||
    /(^|\.)googlevideo\.com$/.test(host)
  ) return false;
  return url.origin === new URL(origin).origin || firebaseStorageHosts.includes(host);
}