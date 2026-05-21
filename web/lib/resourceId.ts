/**
 * Recognises the Twilio resource IDs the dashboard knows how to fetch via
 * `/resource-fetch`. Mirror of the prefix list in functions/resource-fetch.js
 * `classify()` and functions/events-sink.js `extractKey()`.
 */
const PREFIXES = [
  "SM",
  "MM",
  "MG",
  "conv_conversation_",
  "conv_participant_",
  "conv_communication_",
  "conv_configuration_",
  "comms_operation_",
  "mem_profile_",
] as const;

export function isResourceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 3 || value.length > 200) return false;
  return PREFIXES.some((p) => value.startsWith(p));
}

/** Short human-readable label for a resource id, used as a badge in the modal. */
export function resourceKindLabel(id: string): string {
  if (id.startsWith("SM") || id.startsWith("MM")) return "Message";
  if (id.startsWith("MG")) return "Messaging Service";
  if (id.startsWith("conv_conversation_")) return "Conversation";
  if (id.startsWith("conv_participant_")) return "Participant";
  if (id.startsWith("conv_communication_")) return "Communication";
  if (id.startsWith("conv_configuration_")) return "Configuration";
  if (id.startsWith("comms_operation_")) return "Comms operation";
  if (id.startsWith("mem_profile_")) return "Memory profile";
  return "Resource";
}
