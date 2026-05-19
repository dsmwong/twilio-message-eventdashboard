/**
 * GET /comms-senders → 200 { catalogue: [{label, value, status, id, channel}], approved: string[] }
 *
 * Admin-only. Lists ACTIVATED senders from the Twilio Communications API
 * Senders resource (`GET https://comms.twilio.com/v1/Senders`) across the
 * channels we support for outbound (SMS, RCS, WHATSAPP). The `approved`
 * field is the `comms` slice of `approved_senders`.
 *
 * Browsers never get a Sync grant for this catalogue — it is a function-side
 * fetch with the dashboard's account credentials, surfaced through this
 * endpoint.
 */
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);
const { loadApprovedSenders } = require(Runtime.getFunctions()["_shared/sync"].path);
const { listAllActivatedSenders } = require(Runtime.getFunctions()["_shared/comms-api"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    requireAdmin(context, event);

    const senders = await listAllActivatedSenders(context);

    const catalogue = senders
      .map((s) => {
        const value = s.address || "";
        const name = s.displayName;
        const channel = (s.channel || "").toUpperCase();
        const label = name ? `${name} (${value})` : value;
        return { label, value, status: s.status, id: s.id, channel };
      })
      .filter((s) => s.value)
      .sort((a, b) => a.label.localeCompare(b.label));

    const approvedSets = await loadApprovedSenders(context);
    const approved = [...(approvedSets.comms || [])];

    response.setStatusCode(200);
    response.setBody({ catalogue, approved });
    return callback(null, response);
  } catch (err) {
    console.error("[comms-senders] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), upstream: err.upstream });
    return callback(null, response);
  }
};
