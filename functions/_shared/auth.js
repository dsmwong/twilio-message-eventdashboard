/**
 * HMAC-signed session cookie helpers for the dashboard's admin auth.
 *
 * Cookie name: dashboard_session
 * Token shape: <name>.<expiresAtUnix>.<hex(hmacSha256(name + '.' + expiresAtUnix, SESSION_SECRET))>
 *
 * The cookie is set HttpOnly + Secure + SameSite=Lax so JavaScript on the page
 * can't read it (XSS-resistant) and so it isn't sent on cross-site POSTs.
 */

const crypto = require("crypto");

const COOKIE_NAME = "dashboard_session";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

function getSecret(context) {
  const secret = context.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set in environment");
  return secret;
}

function sign(name, expiresAt, secret) {
  const payload = `${name}.${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Build a cookie value (token string) for the given admin name. */
function signSession(name, secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = sign(name, expiresAt, secret);
  return `${name}.${expiresAt}.${sig}`;
}

/** Parse + verify a cookie token. Returns { name } or null. */
function verifySession(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [name, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!name || !Number.isFinite(expiresAt)) return null;
  if (Math.floor(Date.now() / 1000) > expiresAt) return null;
  const expected = sign(name, expiresAt, secret);
  if (!safeEqualHex(sig, expected)) return null;
  return { name };
}

/**
 * Build the Set-Cookie header value for issuing a fresh session.
 * @param token - The signed session token from signSession().
 * @param maxAgeSeconds - Cookie lifetime; should match the token's TTL.
 */
function setCookieHeader(token, maxAgeSeconds = DEFAULT_TTL_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Build the Set-Cookie header that clears the session. */
function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Read the session token from the request.
 *
 * The Twilio Functions runtime (`@twilio/runtime-handler`) parses the Cookie
 * header for us and exposes the result as `event.request.cookies` (a plain
 * object). On a vanilla Express setup the raw header lives at
 * `event.request.headers.cookie`. We try both so this works in both shapes.
 */
function readCookieToken(event) {
  const parsed = event?.request?.cookies;
  if (parsed && typeof parsed === "object" && parsed[COOKIE_NAME]) {
    return parsed[COOKIE_NAME];
  }
  const cookieHeader = event?.request?.headers?.cookie || event?.request?.headers?.Cookie || "";
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=");
  }
  return null;
}

/**
 * Returns { name } for the logged-in admin, or null.
 * Use directly when you want to branch on auth without throwing.
 */
function currentAdmin(context, event) {
  const secret = getSecret(context);
  const token = readCookieToken(event);
  return verifySession(token, secret);
}

/**
 * Throws an Error tagged with `.status = 401` when no valid session is present.
 * Callers should catch and respond 401.
 */
function requireAdmin(context, event) {
  const admin = currentAdmin(context, event);
  if (!admin) {
    const err = new Error("admin login required");
    err.status = 401;
    throw err;
  }
  return admin;
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_SECONDS,
  signSession,
  verifySession,
  setCookieHeader,
  clearCookieHeader,
  readCookieToken,
  currentAdmin,
  requireAdmin,
};
