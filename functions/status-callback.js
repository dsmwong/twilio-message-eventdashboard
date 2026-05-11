const { recordEvent } = require(Runtime.getFunctions()["_shared/sync"].path);

function inferChannel(messageSid, params) {
  const to = params.To || "";
  const from = params.From || "";
  if (to.startsWith("whatsapp:") || from.startsWith("whatsapp:")) return "whatsapp";
  if (to.startsWith("rcs:") || from.startsWith("rcs:")) return "rcs";
  if (messageSid?.startsWith("SM") || messageSid?.startsWith("MM")) return "sms";
  return "sms";
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "text/plain");

  try {
    const messageSid = event.MessageSid || event.SmsSid;
    if (!messageSid) {
      response.setStatusCode(400);
      response.setBody("missing MessageSid");
      return callback(null, response);
    }

    const nowIso = new Date().toISOString();
    const statusTimestamp = event.Timestamp || nowIso;
    const status = event.MessageStatus || event.SmsStatus || "unknown";
    const channel = inferChannel(messageSid, event);

    const { request, ...payload } = event;
    // StatusCallback fires for outbound Messaging API sends; if Direction is absent, treat as outbound.
    const rawDirection = (event.Direction || "").toLowerCase();
    const direction = rawDirection.startsWith("inbound") ? "in" : "out";

    const optOutType = event.OptOutType || undefined;
    await recordEvent(context, {
      messageSid,
      messageMeta: {
        to: event.To,
        from: event.From,
        channel,
        ...(direction ? { direction } : {}),
        ...(optOutType ? { optOutType } : {}),
        lastStatus: status,
        lastStatusAt: statusTimestamp,
      },
      event: {
        source: "status-callback",
        eventType: status,
        timestamp: statusTimestamp,
        receivedAt: nowIso,
        payload,
      },
    });

    response.setStatusCode(204);
    response.setBody("");
    return callback(null, response);
  } catch (err) {
    console.error("[status-callback] error", err);
    response.setStatusCode(500);
    response.setBody(String(err.message || err));
    return callback(null, response);
  }
};
