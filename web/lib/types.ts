export type Channel = "sms" | "whatsapp" | "rcs";

export interface MessageRow {
  to: string;
  from: string;
  channel: Channel;
  direction?: "in" | "out";
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
