import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/env";

/**
 * Field-level encryption for PAN, UPI IDs and OAuth tokens (AES-256-GCM).
 * Ciphertext format: "v1.<iv b64>.<auth tag b64>.<ciphertext b64>".
 * NEVER log plaintext or ciphertext of these fields.
 */
const VERSION = "v1";

function masterKey(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, "base64");
}

// Separate derived keys so the encryption key is never used directly as an HMAC key.
function derivedKey(purpose: "enc" | "index" | "fingerprint"): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), `reelpay:${purpose}`, 32));
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey("enc"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Unrecognised ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", derivedKey("enc"), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Deterministic keyed hash ("blind index") so we can find other users with the same
 * UPI ID or PAN (multi-account fraud) without storing or comparing plaintext.
 */
export function blindIndex(value: string): string {
  return createHmac("sha256", derivedKey("index")).update(value.trim().toLowerCase()).digest("hex");
}

/** Hash for IPs / user agents. We never store raw IPs. */
export function fingerprintHash(value: string): string {
  return createHmac("sha256", derivedKey("fingerprint")).update(value).digest("hex").slice(0, 32);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// --- Masking (safe to display and log) -----------------------------------

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;

/** "ABCDE1234F" -> "ABCDE****F" */
export function maskPan(pan: string): string {
  const p = pan.trim().toUpperCase();
  return `${p.slice(0, 5)}****${p.slice(-1)}`;
}

/** "rahul.sharma@okicici" -> "ra*********@okicici" */
export function maskUpi(upi: string): string {
  const [handle = "", bank = ""] = upi.trim().split("@");
  const visible = handle.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(3, handle.length - 2))}@${bank}`;
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
