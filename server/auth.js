import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHmac } from "node:crypto";

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${h.toString("hex")}`;
}

export function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const want = Buffer.from(h, "hex");
  const got = scryptSync(pw, Buffer.from(s, "hex"), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

const b64 = (x) => Buffer.from(x).toString("base64url");

export function signToken(payload, secret, ttlSec = 30 * 86400) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

// Recovery code: email ke bina password wapas pane ka tareeka. Signup par ek baar dikhta hai.
// Aise akshar chune hain jo galat padhe nahi jaate (0/O, 1/I nahi).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeRecoveryCode() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return [group(), group(), group(), group(), group()].join("-");
}
export function normalizeRecoveryCode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
