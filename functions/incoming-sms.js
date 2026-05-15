/**
 * POST /incoming-sms
 * Twilio posts an inbound SMS (or MMS) here. Record it as a "received" event in Sync and reply with empty TwiML.
 * Twilio request signature is required — unsigned/invalid requests get 403.
 */
const { recordEvent } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireTwilioSignature } = require(Runtime.getFunctions()["_shared/webhook-auth"].path);

function inferChannel(params) {
  const to = params.To || "";
  const from = params.From || "";
  if (to.startsWith("whatsapp:") || from.startsWith("whatsapp:")) return "whatsapp";
  if (to.startsWith("rcs:") || from.startsWith("rcs:")) return "rcs";
  return "sms";
}

exports.handler = async function (context, event, callback) {
  // Reject unsigned / forged requests.
  try {
    requireTwilioSignature(context, event, "/incoming-sms");
  } catch (err) {
    const response = new Twilio.Response();
    response.appendHeader("Content-Type", "application/json");
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }

  const twiml = new Twilio.twiml.MessagingResponse();
  try {
    const messageSid = event.MessageSid || event.SmsMessageSid || event.SmsSid;
    if (messageSid) {
      const nowIso = new Date().toISOString();
      const { request, ...payload } = event;
      const channel = inferChannel(event);

      const optOutType = event.OptOutType || undefined;
      await recordEvent(context, {
        messageSid,
        messageMeta: {
          to: event.To,
          from: event.From,
          channel,
          direction: "in",
          lastStatus: "received",
          lastStatusAt: nowIso,
          ...(optOutType ? { optOutType } : {}),
        },
        event: {
          source: "status-callback",
          eventType: "received",
          timestamp: nowIso,
          receivedAt: nowIso,
          payload,
        },
      });
    }
  } catch (err) {
    console.error("[incoming-sms] error", err);
  }
  return callback(null, twiml);
};
