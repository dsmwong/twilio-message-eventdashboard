export type Channel = "sms" | "whatsapp" | "rcs";

export interface MessageRow {
  to: string;
  from: string;
  channel: Channel;
  direction?: "in" | "out";
  /** STOP / START / HELP — set by Twilio when the inbound body matches an opt-out/opt-in/help keyword. */
  optOutType?: string;
  body?: string;
  contentSid?: string;
  createdAt: string;
  lastStatus?: string;
  lastStatusAt?: string;
}

export interface EventRow {
  source: "status-callback" | "event-stream";
  eventType: string;
  timestamp: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  /** Event Streams only: the full CloudEvents envelope as received. */
  envelope?: Record<string, unknown>;
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
}

export interface AdminInfo {
  name: string;
  createdAt: string;
}
