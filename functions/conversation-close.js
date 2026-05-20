/**
 * POST /conversation-close { conversationId, status? } → 200 (admin-only)
 *
 * Transitions a Conversation Orchestrator (Conversations v2) conversation to
 * ACTIVE, INACTIVE, or CLOSED by PATCHing it. Twilio fires its own
 * CONVERSATION_ACTIVE / CONVERSATION_INACTIVE / CONVERSATION_CLOSED
 * statusCallback as a side-effect; that callback flows back into
 * /orchestrator-callback and updates the dashboard's row.
 *
 * Body:
 *   - conversationId: required, must start with conv_conversation_
 *   - status: "ACTIVE", "INACTIVE", or "CLOSED" (default: "CLOSED")
 *
 * Admin-only: viewers / unauthenticated callers cannot transition conversations.
 *
 * The function name predates the broader transition flow; kept as
 * /conversation-close to avoid breaking existing callers.
 */
const https = require("https");
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);
const { recordEvent } = require(Runtime.getFunctions()["_shared/sync"].path);

const ALLOWED_STATUS = new Set(["ACTIVE", "INACTIVE", "CLOSED"]);

function patchConversation(accountSid, authToken, conversationId, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const req = https.request(
      {
        host: "conversations.twilio.com",
        path: `/v2/Conversations/${encodeURIComponent(conversationId)}`,
        method: "PATCH",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);

    const conversationId = (event.conversationId || "").toString().trim();
    if (!conversationId.startsWith("conv_conversation_")) {
      response.setStatusCode(400);
      response.setBody({ error: "conversationId must be a Conversation Orchestrator id" });
      return callback(null, response);
    }
    const targetStatus = (event.status || "CLOSED").toString().toUpperCase();
    if (!ALLOWED_STATUS.has(targetStatus)) {
      response.setStatusCode(400);
      response.setBody({ error: "status must be one of: ACTIVE, INACTIVE, CLOSED" });
      return callback(null, response);
    }

    const accountSid = context.ACCOUNT_SID;
    const authToken = context.AUTH_TOKEN;
    if (!accountSid || !authToken) {
      response.setStatusCode(500);
      response.setBody({ error: "ACCOUNT_SID/AUTH_TOKEN not available in runtime" });
      return callback(null, response);
    }

    const result = await patchConversation(accountSid, authToken, conversationId, {
      status: targetStatus,
    });
    if (result.status < 200 || result.status >= 300) {
      console.error("[conversation-close] upstream error", result.status, result.body);
      response.setStatusCode(result.status || 502);
      response.setBody({ error: "conversations api error", upstream: result.body });
      return callback(null, response);
    }

    // Update the local Sync row directly. Twilio's statusCallback delivery
    // for programmatic PATCHes is inconsistent (CONVERSATION_ACTIVE in
    // particular may not fire), so we don't rely on the callback for the UI
    // refresh. Also append a synthetic event so the timeline shows the
    // admin-driven transition.
    const nowIso = new Date().toISOString();
    try {
      await recordEvent(context, {
        messageSid: conversationId,
        messageMeta: {
          channel: "conversations",
          conversationId,
          lastStatus: targetStatus,
          lastStatusAt: nowIso,
        },
        event: {
          source: "orchestrator",
          eventType: `CONVERSATION_${targetStatus}`,
          timestamp: nowIso,
          receivedAt: nowIso,
          payload: result.body || { id: conversationId, status: targetStatus },
          envelope: {
            eventType: `CONVERSATION_${targetStatus}`,
            timestamp: nowIso,
            data: result.body || { id: conversationId, status: targetStatus },
            note: "synthesised by /conversation-close (admin-initiated PATCH)",
          },
        },
      });
    } catch (e) {
      console.warn("[conversation-close] local sync update failed", e);
    }

    response.setStatusCode(200);
    response.setBody({ ok: true, conversationId, status: targetStatus });
    return callback(null, response);
  } catch (err) {
    console.error("[conversation-close] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
