/**
 * POST /senders-approved-set  { channel, values: string[] } → 200 (admin-only)
 *
 * Replaces the approved senders list for one channel atomically. UI sends
 * the entire updated array on every checkbox toggle, which avoids race
 * conditions when multiple admins edit at the same time.
 */
const {
  loadApprovedSenders,
  saveApprovedSenders,
  SENDER_CHANNELS,
} = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);

    const channel = (event.channel || "").trim().toLowerCase();
    const rawValues = event.values;
    const values = Array.isArray(rawValues) ? rawValues : [];

    if (!SENDER_CHANNELS.includes(channel)) {
      response.setStatusCode(400);
      response.setBody({ error: `channel must be one of: ${SENDER_CHANNELS.join(", ")}` });
      return callback(null, response);
    }
    if (!values.every((v) => typeof v === "string" && v.length > 0)) {
      response.setStatusCode(400);
      response.setBody({ error: "values must be an array of non-empty strings" });
      return callback(null, response);
    }

    const current = await loadApprovedSenders(context);
    const next = {};
    for (const ch of SENDER_CHANNELS) next[ch] = [...current[ch]];
    next[channel] = Array.from(new Set(values));
    await saveApprovedSenders(context, next);

    response.setStatusCode(200);
    response.setBody({ ok: true, channel, values: next[channel] });
    return callback(null, response);
  } catch (err) {
    console.error("[senders-approved-set] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
