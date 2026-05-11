/**
 * GET /templates
 * Returns normalized Content API templates. Filtering by channel happens in the browser.
 */

const TYPE_CHANNELS = {
  "twilio/text": ["sms", "whatsapp", "rcs"],
  "twilio/media": ["sms", "whatsapp", "rcs"],
  "twilio/location": ["whatsapp", "rcs"],
  "twilio/quick-reply": ["whatsapp", "rcs"],
  "twilio/call-to-action": ["whatsapp", "rcs"],
  "twilio/list-picker": ["whatsapp", "rcs"],
  "twilio/card": ["whatsapp", "rcs"],
  "twilio/carousel": ["whatsapp", "rcs"],
  "twilio/catalog": ["whatsapp"],
  "twilio/flows": ["whatsapp"],
  "twilio/order-details": ["whatsapp"],
  "whatsapp/card": ["whatsapp"],
  "whatsapp/authentication": ["whatsapp"],
};

function channelsFromTypes(typeMap) {
  const types = Object.keys(typeMap || {});
  const set = new Set();
  for (const t of types) {
    for (const ch of TYPE_CHANNELS[t] || []) set.add(ch);
  }
  return { types, channels: Array.from(set) };
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  response.appendHeader("Access-Control-Allow-Origin", "*");

  try {
    const client = context.getTwilioClient();
    const contents = await client.content.v1.contents.list({ limit: 200 });

    const templates = contents.map((c) => {
      const { types, channels } = channelsFromTypes(c.types);
      return {
        sid: c.sid,
        friendlyName: c.friendlyName,
        language: c.language,
        variables: Object.keys(c.variables || {}),
        types,
        channels,
      };
    });

    response.setStatusCode(200);
    response.setBody({ templates });
    return callback(null, response);
  } catch (err) {
    console.error("[templates] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
