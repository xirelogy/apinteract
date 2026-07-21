import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_BYTES = 64;

/** Validates and hashes a password with a fresh scrypt salt. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error("Password must contain at least 10 characters");
  }
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/** Verifies a password against a supported encoded hash in constant time. */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, saltText, expectedText] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    saltText === undefined ||
    expectedText === undefined
  ) {
    return false;
  }
  const expected = Buffer.from(expectedText, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(saltText, "base64url"),
    expected.byteLength,
  )) as Buffer;
  return timingSafeEqual(actual, expected);
}
