/**
 * POST /send-comms
 * Body: { from: string, to: string[], body: string }
 * Auth: signed admin cookie (dashboard_session) — viewers cannot send.
 * Allowlists:
 *   - Every entry in `to` must be present in the `approved_to` Sync Document.
 *   - `from` must be present in `approved_senders.comms`.
 * Issues a single Twilio Communications API operation that fans out to all
 * recipients. The sender's channel (SMS / RCS / WHATSAPP) is resolved
 * server-side from the Comms API Senders resource — the client never
 * dictates it. Returns the operationId from the 202 response.
 *
 * The Comms API endpoint POST https://comms.twilio.com/v1/Messages is not
 * yet typed in the twilio v5 SDK, so this calls it directly via https with
 * HTTP Basic auth (ACCOUNT_SID / AUTH_TOKEN).
 */
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);
const { loadApprovedTo, loadApprovedSenders } = require(Runtime.getFunctions()["_shared/sync"].path);
const {
  listAllActivatedSenders,
  indexByAddress,
  createOperation,
} = require(Runtime.getFunctions()["_shared/comms-api"].path);

const MAX_RECIPIENTS = 100;

/** Map a Comms API sender channel (`SMS|RCS|WHATSAPP`) to the recipient channel string. */
function recipientChannelFor(senderChannel) {
  // Per docs: PHONE covers SMS, MMS, RCS; WHATSAPP for WhatsApp.
  if (senderChannel === "WHATSAPP") return "WHATSAPP";
  return "PHONE";
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    // 1. Admin session required.
    requireAdmin(context, event);

    const { from, body } = event;
    let { to } = event;
    if (typeof to === "string") {
      try {
        to = JSON.parse(to);
      } catch {
        to = [to];
      }
    }

    if (!from || !body || !Array.isArray(to) || to.length === 0) {
      response.setStatusCode(400);
      response.setBody({ error: "from, to[], and body are required" });
      return callback(null, response);
    }
    if (to.length > MAX_RECIPIENTS) {
      response.setStatusCode(400);
      response.setBody({ error: `too many recipients (max ${MAX_RECIPIENTS})` });
      return callback(null, response);
    }
    if (!to.every((v) => typeof v === "string" && v.length > 0)) {
      response.setStatusCode(400);
      response.setBody({ error: "to must be an array of non-empty strings" });
      return callback(null, response);
    }

    // 2. Every destination must be in approved_to.
    const approvedTo = await loadApprovedTo(context);
    if (!approvedTo) {
      response.setStatusCode(503);
      response.setBody({ error: "approved_to allowlist is not configured" });
      return callback(null, response);
    }
    const rejected = to.filter((v) => !approvedTo.has(v));
    if (rejected.length > 0) {
      response.setStatusCode(403);
      response.setBody({ error: "destination(s) not in allowlist", rejected });
      return callback(null, response);
    }

    // 3. From must be in approved_senders.comms.
    const approvedSenders = await loadApprovedSenders(context);
    if (!approvedSenders.comms || !approvedSenders.comms.has(from)) {
      response.setStatusCode(403);
      response.setBody({ error: "sender not approved for comms channel" });
      return callback(null, response);
    }

    // 4. Resolve the sender's channel from the Comms API itself — the client
    //    never dictates it. Also confirms the sender is still ACTIVATED.
    const allSenders = await listAllActivatedSenders(context);
    const sender = indexByAddress(allSenders).get(from);
    if (!sender) {
      response.setStatusCode(409);
      response.setBody({ error: "sender not found or not activated in Comms API" });
      return callback(null, response);
    }
    const fromChannel = (sender.channel || "").toUpperCase();
    const toChannel = recipientChannelFor(fromChannel);

    // 5. Build and issue the Comms API operation.
    const payload = {
      from: { address: from, channel: fromChannel },
      to: to.map((address) => ({ address, channel: toChannel })),
      content: { text: body },
    };

    const result = await createOperation(context, payload);
    if (result.status !== 202 && result.status !== 200) {
      console.error("[send-comms] upstream error", result.status, result.body);
      response.setStatusCode(result.status || 502);
      response.setBody({ error: "comms api error", upstream: result.body });
      return callback(null, response);
    }

    const operationId = (result.body && result.body.operationId) || result.headers["operationid"];
    response.setStatusCode(200);
    response.setBody({
      operationId,
      recipientCount: to.length,
      fromChannel,
    });
    return callback(null, response);
  } catch (err) {
    console.error("[send-comms] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), upstream: err.upstream });
    return callback(null, response);
  }
};
