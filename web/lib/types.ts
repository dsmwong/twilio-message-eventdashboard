/** Channels the SendForm can target. */
export type Channel = "sms" | "whatsapp" | "rcs" | "comms";

/** Channel value stored on a MessageRow. `conversations` is observe-only. */
export type MessageChannel = Channel | "conversations";

export interface MessageRow {
  to: string;
  from: string;
  channel: MessageChannel;
  direction?: "in" | "out";
  /** STOP / START / HELP — set by Twilio when the inbound body matches an opt-out/opt-in/help keyword. */
  optOutType?: string;
  body?: string;
  contentSid?: string;
  createdAt: string;
  lastStatus?: string;
  lastStatusAt?: string;
  /** Conversations rows only: every participant address on the conversation. */
  participantAddresses?: string[];
  /** Conversations rows only: the orchestrator-issued conversation id (same as the row key). */
  conversationId?: string;
}

export interface EventRow {
  source: "status-callback" | "event-stream" | "orchestrator";
  eventType: string;
  timestamp: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  /** Event Streams only: the full CloudEvents envelope as received. */
  envelope?: Record<string, unknown>;
}

/** Phone-to-conversations index, mirrored from the public Sync Document. */
export interface PhoneIndexEntry {
  conversationIds: string[];
  lastActivityAt: string | null;
}
export interface PhoneIndex {
  numbers: Record<string, PhoneIndexEntry>;
}

export interface TemplateSummary {
  sid: string;
  friendlyName: string;
  language: string;
  variables: string[];
  channels: Channel[];
  types: string[];
}

export interface Sender {
  label: string;
  value: string;
  kind: "phone" | "messaging-service" | "whatsapp" | "rcs-agent";
}

export interface SendersConfig {
  sms: Sender[];
  whatsapp: Sender[];
  rcs: Sender[];
}

/**
 * Comms API sender catalogue (loaded live from /comms-senders, not from Sync).
 * `value` is the bare phone number / address; `channel` is the upstream
 * Comms API channel (SMS / RCS / WHATSAPP); `status` is `ACTIVATED` for
 * everything we surface (the function filters out DEACTIVATED).
 */
export interface CommsSender {
  label: string;
  value: string;
  status: string;
  id?: string;
  channel?: string;
}

export interface ApprovedNumber {
  label: string;
  value: string;
  /** ISO timestamp of the Twilio Verify confirmation. Absent on legacy entries. */
  verifiedAt?: string;
  /** Name of the admin who completed verification. */
  verifiedBy?: string;
}

export interface ApprovedToConfig {
  numbers: ApprovedNumber[];
}

export interface ApprovedSendersConfig {
  sms: string[];
  whatsapp: string[];
  rcs: string[];
  comms: string[];
}

export interface AdminInfo {
  name: string;
  createdAt: string;
}
