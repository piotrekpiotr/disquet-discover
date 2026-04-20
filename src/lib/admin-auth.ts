/**
 * Admin session primitives. Designed to run inside the Edge runtime (middleware)
 * as well as Node (API routes), so it uses only Web Crypto - no `crypto` import.
 *
 * Session model: a single signed cookie called `disquet_admin`. Value is
 *
 *     base64url(issuedAtMs . "." . hmacSha256(secret, issuedAtMs))
 *
 * The cookie is validated on every admin request:
 *   - HMAC must verify against ADMIN_SESSION_SECRET (constant-time).
 *   - issuedAtMs must be within SESSION_TTL_MS of now.
 *
 * This is intentionally small. There is no user table, no refresh tokens, no
 * CSRF token store - a single-curator site doesn't need them. What matters is:
 *   1. The admin password never leaves the server (the cookie is an opaque
 *      HMAC, not the password).
 *   2. Tampering is detectable (bad HMAC → 401).
 *   3. Cookies are httpOnly + Secure + SameSite=Lax so they can't be read by
 *      embedded players or stolen by XSS.
 *
 * Password check is constant-time to defeat timing side-channels on short
 * passwords. It's not strictly necessary against a remote attacker (network
 * jitter dwarfs nanosecond string-compare differences), but free and correct.
 */

export const ADMIN_COOKIE = "disquet_admin";
/** 7 days. Covers a normal curation week on one laptop. Re-login is one click. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret(): string {
  // ADMIN_SESSION_SECRET is preferred. Fall back to ADMIN_PASSWORD so the
  // first-run setup only needs a single env var; deployments can separate
  // them for rotation later.
  const secret =
    process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
  if (!secret) {
    throw new Error(
      "ADMIN_SESSION_SECRET (or ADMIN_PASSWORD) must be set to use admin auth.",
    );
  }
  return secret;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa is available in both Edge runtime and Node 18+.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return bytes;
}

async function hmacSha256(key: string, msg: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return new Uint8Array(sig);
}

/** Constant-time byte comparison. Avoids early-exit timing side channel. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Build a new signed cookie value. */
export async function signSession(issuedAtMs: number = Date.now()): Promise<string> {
  const msg = String(issuedAtMs);
  const mac = await hmacSha256(getSecret(), msg);
  return `${msg}.${b64urlEncode(mac)}`;
}

/** Verify a cookie value. Returns true iff signature is valid AND not expired. */
export async function verifySession(cookieValue: string | undefined | null): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot < 1) return false;
  const issuedStr = cookieValue.slice(0, dot);
  const macStr = cookieValue.slice(dot + 1);
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued)) return false;
  if (Date.now() - issued > SESSION_TTL_MS) return false;
  let presented: Uint8Array;
  try {
    presented = b64urlDecode(macStr);
  } catch {
    return false;
  }
  const expected = await hmacSha256(getSecret(), issuedStr);
  return timingSafeEqual(presented, expected);
}

/** Constant-time password check used by the login route. */
export async function checkPassword(candidate: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  // Normalise by hashing both sides - constant-time regardless of length diffs.
  const enc = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(candidate)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(expected)));
  return timingSafeEqual(a, b);
}
