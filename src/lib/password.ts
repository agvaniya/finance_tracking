import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

// scrypt ships with Node, so there is no native dependency to build in the
// container. These are the parameters the Node docs recommend as a sane
// interactive default; N dominates both time and memory cost.
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Stored form: `scrypt$<salt-hex>$<hash-hex>` */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(secret.normalize("NFKC"), salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(secret.normalize("NFKC"), Buffer.from(saltHex, "hex"), expected.length);
  // Lengths match by construction, but timingSafeEqual throws if they differ.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Security answers are compared case- and whitespace-insensitively: people do
 * not retype "St. Mary's" identically months later. The normalised form is
 * what gets hashed, so the stored value never reveals the original casing.
 */
export function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function hashAnswer(answer: string): Promise<string> {
  return hashSecret(normalizeAnswer(answer));
}

export async function verifyAnswer(answer: string, stored: string): Promise<boolean> {
  return verifySecret(normalizeAnswer(answer), stored);
}
