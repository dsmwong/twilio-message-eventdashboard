/**
 * GET /resource-fetch?id=<id>[&conversationId=<conv>] → 200 { kind, id, resource }
 *
 * Fetches the canonical Twilio resource for any recognised id prefix and
 * returns its JSON. On-demand only — never cached in Sync.
 *
 * Recognised prefixes:
 *   SM…  /  MM…           → Programmable Messaging Message (SDK)
 *   MG…                   → Messaging Service (SDK: client.messaging.v1.services)
 *   conv_conversation_…   → Conversations v2 conversation
 *   conv_participant_…    → Conversations v2 participant
 *   conv_communication_…  → Conversations v2 communication
 *   conv_configuration_…  → Conversation Orchestrator Configuration
 *   comms_operation_…     → Communications API operation
 *   mem_profile_…         → Conversation Memory profile (requires MEMORY_STORE_ID)
 *
 * Auth: open. The endpoint is read-only; the data it returns (message bodies,
 * participant addresses) is already visible to viewers in the existing
 * timeline UI. Limit ids to a safe charset before passing to Twilio.
 */
const {
  getConversation,
  getParticipant,
  getCommunication,
  getConfiguration,
} = require(Runtime.getFunctions()["_shared/conversations-api"].path);
const { getOperation } = require(Runtime.getFunctions()["_shared/comms-api"].path);
const { getProfile } = require(Runtime.getFunctions()["_shared/memory-api"].path);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function classify(id) {
  if (id.startsWith("SM") || id.startsWith("MM")) return "message";
  if (id.startsWith("MG")) return "messaging-service";
  if (id.startsWith("conv_conversation_")) return "conversation";
  if (id.startsWith("conv_participant_")) return "participant";
  if (id.startsWith("conv_communication_")) return "communication";
  if (id.startsWith("conv_configuration_")) return "configuration";
  if (id.startsWith("comms_operation_")) return "comms-operation";
  if (id.startsWith("mem_profile_")) return "memory-profile";
  return null;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    const id = (event.id || "").toString().trim();
    if (!id) {
      response.setStatusCode(400);
      response.setBody({ error: "id query parameter is required" });
      return callback(null, response);
    }
    if (!ID_PATTERN.test(id)) {
      response.setStatusCode(400);
      response.setBody({ error: "id contains illegal characters or is too long" });
      return callback(null, response);
    }
    const kind = classify(id);
    if (!kind) {
      response.setStatusCode(400);
      response.setBody({ error: "unrecognized resource id", id });
      return callback(null, response);
    }
    const conversationId = (event.conversationId || "").toString().trim() || undefined;
    if (conversationId && !ID_PATTERN.test(conversationId)) {
      response.setStatusCode(400);
      response.setBody({ error: "conversationId contains illegal characters or is too long" });
      return callback(null, response);
    }

    let resource;
    if (kind === "message") {
      const client = context.getTwilioClient();
      const msg = await client.messages(id).fetch();
      // The SDK returns an Instance with non-enumerable methods; serialise it
      // through JSON to get the plain shape the dashboard expects.
      resource = JSON.parse(JSON.stringify(msg));
    } else if (kind === "messaging-service") {
      const client = context.getTwilioClient();
      const svc = await client.messaging.v1.services(id).fetch();
      resource = JSON.parse(JSON.stringify(svc));
    } else if (kind === "conversation") {
      resource = await getConversation(context, id);
    } else if (kind === "participant") {
      resource = await getParticipant(context, id, conversationId);
    } else if (kind === "communication") {
      resource = await getCommunication(context, id, conversationId);
    } else if (kind === "configuration") {
      resource = await getConfiguration(context, id);
    } else if (kind === "comms-operation") {
      resource = await getOperation(context, id);
    } else if (kind === "memory-profile") {
      resource = await getProfile(context, id);
    }

    response.setStatusCode(200);
    response.setBody({ kind, id, resource });
    return callback(null, response);
  } catch (err) {
    console.error("[resource-fetch] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), upstream: err.upstream });
    return callback(null, response);
  }
};
