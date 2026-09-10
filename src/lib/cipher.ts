// Encrypt-at-rest for Connection secrets, per docs/research/auth-patterns.md #5 (n8n's Cipher-service pattern —
// one central service, secrets held decrypted only transiently, never persisted plaintext). AES-256-GCM via
// node:crypto (Bun ships full Node crypto compat; there's no Bun-native primitive for this per CLAUDE.md's
// Bun-API list, which only covers fs/sqlite/redis/postgres/websocket, not general encryption).
//
// This is the ONLY file that touches ENCRYPTION_KEY or does actual crypto — src/core/store.ts calls
// encrypt()/decrypt() at the storage boundary; every other file in the codebase only ever sees a decrypted
// Secrets object (Connection.secrets), never ciphertext, never this module.

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the standard/recommended size for GCM
const AUTH_TAG_LENGTH = 16;

// config.ts already validated ENCRYPTION_KEY is present and decodes to 32 bytes at startup — this just
// does the decode again (cheap, keeps this module self-contained rather than caching a Buffer at import time).
function getKey(): Buffer {
  return Buffer.from(config.security.ENCRYPTION_KEY, "base64");
}

// Packs iv + authTag + ciphertext into one base64 string so callers only ever store/pass around a single
// opaque string, not three separate pieces they could mix up or lose track of.
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decrypt(packed: string): string {
  const key = getKey();
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag); // throws on decrypt() below if the ciphertext was tampered with or the key is wrong
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
