/**
 * Cloudflare-compatible RFC 8291 (aes128gcm) Web Push and RFC 8292 VAPID.
 *
 * This module intentionally has no provider, database, or Node runtime
 * dependency. The caller supplies the subscription and a fetch implementation.
 */

export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type PushDeliveryResult = {
  endpoint: string;
  ok: boolean;
  status: number;
  stale: boolean;
};

const encoder = new TextEncoder();

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function b64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url key");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  // Web Crypto's HKDF operation performs Extract and Expand together. This
  // helper is deliberately Expand-only because callers pass an already
  // extracted RFC 8291 PRK.
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const output = new Uint8Array(length);
  let previous = new Uint8Array();
  let written = 0;
  for (let counter = 1; written < length; counter++) {
    previous = new Uint8Array(await crypto.subtle.sign(
      "HMAC", key, concat(previous, info, new Uint8Array([counter])) as BufferSource,
    ));
    const chunk = previous.slice(0, Math.min(previous.length, length - written));
    output.set(chunk, written);
    written += chunk.length;
  }
  return output;
}

async function hkdfExtract(salt: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", salt as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input as BufferSource));
}

function publicJwk(raw: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID public key must be an uncompressed P-256 key");
  return { kty: "EC", crv: "P-256", x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33, 65)), ext: true };
}

async function ecdhPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

function derSignatureToRaw(signature: Uint8Array): Uint8Array {
  // Web Crypto implementations commonly return ASN.1 DER for ECDSA.
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30) throw new Error("Unexpected ECDSA signature format");
  let index = 2;
  const read = (): Uint8Array => {
    if (signature[index++] !== 0x02) throw new Error("Invalid ECDSA signature");
    const length = signature[index++];
    const value = signature.slice(index, index + length);
    index += length;
    return value[0] === 0 ? value.slice(1) : value;
  };
  const r = read();
  const s = read();
  const output = new Uint8Array(64);
  output.set(r, 32 - r.length);
  output.set(s, 64 - s.length);
  return output;
}

async function vapidAuthorization(endpoint: URL, keys: VapidKeys): Promise<string> {
  const publicRaw = fromB64url(keys.publicKey);
  const privateRaw = fromB64url(keys.privateKey);
  if (privateRaw.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    { ...publicJwk(publicRaw), d: b64url(privateRaw), key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const claims = b64url(encoder.encode(JSON.stringify({ aud: endpoint.origin, exp: expiry, sub: keys.subject })));
  const signingInput = encoder.encode(`${header}.${claims}`);
  const signature = derSignatureToRaw(bytes(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, signingInput,
  )));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** Encrypts a JSON-compatible payload into an RFC 8291 aes128gcm record. */
export async function encryptPushPayload(
  subscription: WebPushSubscription,
  payload: Uint8Array | string | Record<string, unknown>,
): Promise<Uint8Array> {
  const receiverRaw = fromB64url(subscription.keys.p256dh);
  const auth = fromB64url(subscription.keys.auth);
  if (receiverRaw.length !== 65 || auth.length !== 16) throw new Error("Invalid Web Push subscription keys");
  const receiver = await ecdhPublicKey(receiverRaw);
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  )) as CryptoKeyPair;
  const senderRaw = bytes(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, ephemeral.privateKey, 256));
  const info = concat(encoder.encode("WebPush: info\0"), receiverRaw, senderRaw);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // RFC 8291: authenticate the ECDH secret with the subscription auth
  // secret, bind both public keys, then extract again with the per-message salt.
  const authPrk = await hkdfExtract(auth, shared);
  const ikm = await hkdf(authPrk, new Uint8Array(), info, 32);
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdf(prk, new Uint8Array(), encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(prk, new Uint8Array(), encoder.encode("Content-Encoding: nonce\0"), 12);
  const body = typeof payload === "string" ? encoder.encode(payload)
    : payload instanceof Uint8Array ? payload : encoder.encode(JSON.stringify(payload));
  const plaintext = concat(body, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = bytes(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, plaintext as BufferSource));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([senderRaw.length]), senderRaw, ciphertext);
}

export function validateWebPushEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Push endpoint must be a valid HTTPS URL"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  const knownPushProvider =
    host === "fcm.googleapis.com" ||
    host === "push.services.mozilla.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host === "notify.windows.com" ||
    host.endsWith(".notify.windows.com");
  if (url.protocol !== "https:" || !host || url.username !== "" || url.password !== "" ||
      (url.port !== "" && url.port !== "443") || !knownPushProvider ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "::1" || host === "0.0.0.0" || host === "::" ||
      ipLiteral ||
      /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split(".").some((part) => Number(part) > 255))) {
    throw new Error("Push endpoint targets a private or local address");
  }
  return url;
}

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: Uint8Array | string | Record<string, unknown>,
  vapid: VapidKeys,
  fetcher: typeof fetch = fetch,
): Promise<PushDeliveryResult> {
  const endpoint = validateWebPushEndpoint(subscription.endpoint);
  const body = await encryptPushPayload(subscription, payload);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { Authorization: await vapidAuthorization(endpoint, vapid), "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", TTL: "86400" },
    body: body.buffer as ArrayBuffer,
  });
  return { endpoint: subscription.endpoint, ok: response.ok, status: response.status, stale: response.status === 404 || response.status === 410 };
}
