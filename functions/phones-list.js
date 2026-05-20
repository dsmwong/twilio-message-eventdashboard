/**
 * GET /phones-list → 200 { phones: [{value, conversationCount, lastActivityAt}] }
 *
 * Reads the public `phone_to_conversations` Sync Document and returns a
 * sorted, summarised view. The browser primarily subscribes to the Sync
 * Document directly (live updates); this REST endpoint is a non-Sync fallback
 * (e.g. for one-off curl probes or if the Sync grant fails).
 */
const { loadPhoneIndex } = require(Runtime.getFunctions()["_shared/sync"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    const numbers = await loadPhoneIndex(context);
    const phones = Object.entries(numbers).map(([value, info]) => ({
      value,
      conversationCount: Array.isArray(info.conversationIds) ? info.conversationIds.length : 0,
      lastActivityAt: info.lastActivityAt || null,
    }));
    phones.sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""));
    response.setStatusCode(200);
    response.setBody({ phones });
    return callback(null, response);
  } catch (err) {
    console.error("[phones-list] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
