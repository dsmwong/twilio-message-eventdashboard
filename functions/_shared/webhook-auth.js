/**
 * Twilio request signature validation for inbound webhooks.
 *
 * Twilio signs every webhook with HMAC-SHA1(authToken, fullURL + sortedFormParams)
 * and sends the digest in the `X-Twilio-Signature` header. We re-compute and
 * compare; mismatch = forged or replayed request → 403.
 *
 * Notes on this runtime:
 * - Header is exposed at `event.request.headers['x-twilio-signature']` (lowercased).
 * - `event.request.headers['x-twilio-signature']` is *not* present in the deployed
 *   runtime by default — we have to opt in via the function-config or read directly.
 *   The deployed Twilio Functions runtime does include it when the function is
 *   public and the request is form-encoded; it's the same header Twilio always sends.
 * - Form params are spread onto `event` (minus `request` / `bodySHA256`).
 * - The URL we sign against must match exactly what Twilio used to make the
 *   request: include scheme + host + path. We use PUBLIC_BASE_URL (for ngrok
 *   local dev) or `https://${DOMAIN_NAME}` (deployed Serverless).
 */

function urlFor(context, path) {
  const base = (context.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (base) return `${base}${path}`;
  const domain = context.DOMAIN_NAME || "";
  if (!domain) return null;
  return `https://${domain}${path}`;
}

/**
 * Throws Error with `.status = 403` if the signature is missing or invalid.
 * Pass the path the function is mounted at, e.g. "/incoming-sms".
 */
function requireTwilioSignature(context, event, path) {
  // Local-dev escape hatch: tunneled requests from real Twilio still verify;
  // unsigned local curl-tests do not. Skip only when explicitly told to.
  if (context.SKIP_TWILIO_SIGNATURE === "true") return;

  const authToken = context.AUTH_TOKEN;
  if (!authToken) {
    const err = new Error("AUTH_TOKEN not set; cannot validate signature");
    err.status = 503;
    throw err;
  }

  const url = urlFor(context, path);
  if (!url) {
    const err = new Error("cannot resolve public URL for signature check");
    err.status = 503;
    throw err;
  }

  const headers = event?.request?.headers || {};
  const signature = headers["x-twilio-signature"] || headers["X-Twilio-Signature"] || "";
  if (!signature) {
    const err = new Error("missing X-Twilio-Signature header");
    err.status = 403;
    throw err;
  }

  // Build params from event, stripping runtime-injected keys.
  const { request, bodySHA256, ...params } = event;

  const ok = Twilio.validateRequest(authToken, signature, url, params);
  if (!ok) {
    const err = new Error("invalid Twilio signature");
    err.status = 403;
    throw err;
  }
}

module.exports = { requireTwilioSignature, urlFor };
