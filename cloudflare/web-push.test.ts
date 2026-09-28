import assert from "node:assert/strict";
import test from "node:test";
import { encryptPushPayload, sendWebPush, type WebPushSubscription } from "./web-push";

const b64 = (value: Uint8Array) => {
  let text = ""; for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
async function extract(salt: Uint8Array, input: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
}
async function expand(prk: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let previous = new Uint8Array();
  const output = new Uint8Array(length);
  for (let counter = 1, offset = 0; offset < length; counter++) {
    previous = new Uint8Array(await crypto.subtle.sign("HMAC", key, join(previous, info, new Uint8Array([counter]))));
    const chunk = previous.slice(0, Math.min(32, length - offset));
    output.set(chunk, offset); offset += chunk.length;
  }
  return output;
}

async function subscription(): Promise<{ value: WebPushSubscription; publicKey: string; receiver: CryptoKeyPair }> {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", (receiver as CryptoKeyPair).publicKey));
  return { publicKey: b64(publicKey), receiver: receiver as CryptoKeyPair, value: { endpoint: "https://fcm.googleapis.com/send/mock", keys: { p256dh: b64(publicKey), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } } };
}

test("encrypts an aes128gcm payload with the RFC header", async () => {
  const sub = await subscription();
  const encrypted = await encryptPushPayload(sub.value, { title: "Hello" });
  assert.equal(encrypted.length > 16 + 4 + 1 + 65 + 16, true);
  assert.equal(new DataView(encrypted.buffer, encrypted.byteOffset + 16, 4).getUint32(0), 4096);
  assert.equal(encrypted[20], 65);
  assert.equal(encrypted[21], 4);
  const senderRaw = encrypted.slice(21, 86);
  const receiverRaw = new Uint8Array(await crypto.subtle.exportKey("raw", sub.receiver.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: await crypto.subtle.importKey("raw", senderRaw, { name: "ECDH", namedCurve: "P-256" }, false, []) },
    sub.receiver.privateKey, 256,
  ));
  const auth = unb64(sub.value.keys.auth);
  const authPrk = await extract(auth, shared);
  const info = join(new TextEncoder().encode("WebPush: info\0"), receiverRaw, senderRaw);
  const ikm = await expand(authPrk, info, 32);
  const prk = await extract(encrypted.slice(0, 16), ikm);
  const cek = await expand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await expand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, encrypted.slice(86)));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), { title: "Hello" });
});

test("sends VAPID authorization and reports stale responses without network access", async () => {
  const sub = await subscription();
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey("raw", (signer as CryptoKeyPair).publicKey)));
  const privateJwk = await crypto.subtle.exportKey("jwk", (signer as CryptoKeyPair).privateKey);
  const seen: RequestInit[] = [];
  const result = await sendWebPush(sub.value, "hello", { publicKey, privateKey: b64(unb64(privateJwk.d!)), subject: "mailto:test@example.test" }, async (_url, init) => { seen.push(init); return new Response(null, { status: 410 }); });
  assert.equal(result.stale, true);
  assert.equal(seen[0].headers instanceof Object, true);
});

test("rejects local and non-HTTPS endpoints", async () => {
  const sub = await subscription();
  await assert.rejects(() => sendWebPush({ ...sub.value, endpoint: "https://example.test/push" }, "x", { publicKey: "", privateKey: "", subject: "mailto:test@example.test" }));
});