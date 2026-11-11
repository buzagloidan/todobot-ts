/**
 * Fernet-compatible encrypt/decrypt for Cloudflare Workers.
 *
 * Python key setup (bot.py):
 *   Fernet.generate_key()          → fernet_key (44-char base64url string, = base64url(32 raw bytes))
 *   ENCRYPTION_KEY env             = base64url_encode(fernet_key)   ← stored as env var
 *   At runtime: base64url_decode(ENCRYPTION_KEY) → fernet_key bytes (44 ASCII bytes)
 *   Fernet(fernet_key_bytes)       → uses first 16 bytes of raw key as HMAC, last 16 as AES
 *
 * So in TypeScript we must decode TWICE:
 *   step1 = base64urlDecode(ENCRYPTION_KEY)         → 44 ASCII bytes of fernet key
 *   step2 = base64urlDecode(textDecode(step1))      → 32 raw bytes
 *   hmac_signing_key  = step2[0..15]
 *   aes_encryption_key = step2[16..31]
 *
 * Token layout (after base64url decode of the stored token):
 *   version   : 1 byte  (0x80)
 *   timestamp : 8 bytes (uint64 big-endian)
 *   IV        : 16 bytes
 *   ciphertext: N bytes (AES-128-CBC, PKCS7 padded)
 *   HMAC      : 32 bytes (HMAC-SHA256 of everything above)
 *
 * DB column stores: base64url( base64url(fernetToken) )
 * (bot.py encrypt_data wraps the fernet token in a second base64url layer)
 */

function base64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the ENCRYPTION_KEY env var to get the raw 32-byte key material */
function getRawKey(encryptionKey: string): Uint8Array {
  // Step 1: outer decode → gives fernet key as ASCII bytes (44 bytes)
  const fernetKeyBytes = base64urlDecode(encryptionKey);
  // Step 2: inner decode → gives raw 32 bytes
  const fernetKeyStr = new TextDecoder().decode(fernetKeyBytes);
  return base64urlDecode(fernetKeyStr);
}

async function importKeys(rawKey: Uint8Array): Promise<{ hmacKey: CryptoKey; aesKey: CryptoKey }> {
  const [hmacKey, aesKey] = await Promise.all([
    crypto.subtle.importKey(
      "raw",
      rawKey.slice(0, 16),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    ),
    crypto.subtle.importKey(
      "raw",
      rawKey.slice(16, 32),
      { name: "AES-CBC" },
      false,
      ["encrypt", "decrypt"]
    ),
  ]);
  return { hmacKey, aesKey };
}

function getTimestampBytes(ts: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, 0, false);
  view.setUint32(4, ts, false);
  return new Uint8Array(buf);
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) throw new Error("Invalid PKCS7 padding");
  return data.slice(0, data.length - pad);
}

export async function fernetEncrypt(plaintext: string, encryptionKey: string): Promise<string> {
  const rawKey = getRawKey(encryptionKey);
  const { hmacKey, aesKey } = await importKeys(rawKey);

  const ts = Math.floor(Date.now() / 1000);
  const tsBytes = getTimestampBytes(ts);
  const iv = crypto.getRandomValues(new Uint8Array(16));

  const padded = pkcs7Pad(new TextEncoder().encode(plaintext));
  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, padded);
  const ciphertext = new Uint8Array(ciphertextBuf);

  // signed = version(1) + timestamp(8) + iv(16) + ciphertext
  const signedLen = 1 + 8 + 16 + ciphertext.length;
  const signed = new Uint8Array(signedLen);
  signed[0] = 0x80;
  signed.set(tsBytes, 1);
  signed.set(iv, 9);
  signed.set(ciphertext, 25);

  const hmacBuf = await crypto.subtle.sign("HMAC", hmacKey, signed);
  const hmac = new Uint8Array(hmacBuf);

  // token = signed + hmac
  const token = new Uint8Array(signedLen + 32);
  token.set(signed);
  token.set(hmac, signedLen);

  // Outer encoding: base64url(base64url(token)) — mirrors Python encrypt_data
  const innerB64 = base64urlEncode(token);
  return base64urlEncode(new TextEncoder().encode(innerB64));
}

export async function fernetDecrypt(stored: string, encryptionKey: string): Promise<string> {
  // Undo outer base64url → bytes of inner b64 string
  const innerBytes = base64urlDecode(stored);
  const fernetB64 = new TextDecoder().decode(innerBytes);

  // Decode inner b64 → raw fernet token bytes
  const token = base64urlDecode(fernetB64);

  if (token[0] !== 0x80) throw new Error("Invalid Fernet version byte");
  const signedLen = token.length - 32;
  if (signedLen < 25) throw new Error("Fernet token too short");

  const signed = token.slice(0, signedLen);
  const hmacBytes = token.slice(signedLen);
  const iv = token.slice(9, 25);
  const ciphertext = token.slice(25, signedLen);

  const rawKey = getRawKey(encryptionKey);
  const { hmacKey, aesKey } = await importKeys(rawKey);

  const valid = await crypto.subtle.verify("HMAC", hmacKey, hmacBytes, signed);
  if (!valid) throw new Error("Fernet HMAC verification failed");

  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext);
  return new TextDecoder().decode(pkcs7Unpad(new Uint8Array(plaintextBuf)));
}
