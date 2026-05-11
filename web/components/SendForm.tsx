"use client";

import { useEffect, useMemo, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { Channel, Sender, SendersConfig, TemplateSummary } from "../lib/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "rcs", label: "RCS" },
];

const FREE_FORM = "__free__";
const RECENT_TO_KEY = "dashboard:recent-to";
const RECENT_TO_MAX = 10;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_TO_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_TO_KEY, JSON.stringify(list));
  } catch {
    /* storage disabled / full */
  }
}

export function SendForm() {
  const [channel, setChannel] = useState<Channel>("sms");
  const [senders, setSenders] = useState<SendersConfig | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [templateSid, setTemplateSid] = useState<string>(FREE_FORM);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [recentTo, setRecentTo] = useState<string[]>([]);

  useEffect(() => {
    setRecentTo(loadRecents());
  }, []);

  useEffect(() => {
    fetch("/templates")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`templates ${r.status}`))))
      .then((json: { templates: TemplateSummary[] }) => setTemplates(json.templates))
      .catch((e) => setStatus(`Failed to load templates: ${e.message}`));
  }, []);

  useEffect(() => {
    let doc: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["document"]>> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const client = await getSyncClient();
        doc = await client.document("senders");
        if (cancelled) return;
        const apply = (d: unknown) => setSenders(d as SendersConfig);
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        setStatus(
          `Failed to load senders from Sync: ${e instanceof Error ? e.message : String(e)}. Run \`pnpm run refresh:senders\`.`
        );
      }
    })();

    return () => {
      cancelled = true;
      doc?.close();
    };
  }, []);

  const channelSenders: Sender[] = useMemo(() => (senders ? senders[channel] ?? [] : []), [senders, channel]);

  const channelTemplates = useMemo(
    () => (templates ?? []).filter((t) => t.channels.includes(channel)),
    [templates, channel]
  );

  useEffect(() => {
    setFrom(channelSenders[0]?.value ?? "");
  }, [channelSenders]);

  useEffect(() => {
    if (channel !== "sms") {
      if (templateSid === FREE_FORM) setTemplateSid(channelTemplates[0]?.sid ?? "");
    }
  }, [channel, channelTemplates, templateSid]);

  const selectedTemplate = channelTemplates.find((t) => t.sid === templateSid);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const payload: Record<string, unknown> = { channel, to, from };
      if (templateSid === FREE_FORM) payload.body = body;
      else {
        payload.contentSid = templateSid;
        if (selectedTemplate?.variables.length) payload.contentVariables = vars;
      }
      const res = await fetch("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `send ${res.status}`);
      setStatus(`Sent: ${json.sid}`);
      const trimmed = to.trim();
      if (trimmed) {
        const next = [trimmed, ...recentTo.filter((x) => x !== trimmed)].slice(0, RECENT_TO_MAX);
        setRecentTo(next);
        saveRecents(next);
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="row">
        <label className="stack" style={{ flex: "1 1 120px" }}>
          <span className="muted">Channel</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ flex: "2 1 200px" }}>
          <span className="muted">From</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {channelSenders.length === 0 && <option value="">No senders configured</option>}
            {channelSenders.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ flex: "2 1 200px" }}>
          <span className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="muted">To (E.164)</span>
            {recentTo.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRecentTo([]);
                  saveRecents([]);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--muted)",
                  padding: 0,
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: "pointer",
                }}
                title="Clear recent To numbers"
              >
                clear recents
              </button>
            )}
          </span>
          <input
            list="recent-to-list"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+15551234567"
            autoComplete="off"
            required
          />
          <datalist id="recent-to-list">
            {recentTo.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {recentTo.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setTo(e.target.value);
              }}
              style={{ marginTop: 4, fontSize: 12 }}
            >
              <option value="">Recent…</option>
              {recentTo.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>

      <label className="stack">
        <span className="muted">Template</span>
        <select value={templateSid} onChange={(e) => setTemplateSid(e.target.value)}>
          {channel === "sms" && <option value={FREE_FORM}>Free-form body</option>}
          {channelTemplates.length === 0 && channel !== "sms" && <option value="">No templates for {channel}</option>}
          {channelTemplates.map((t) => (
            <option key={t.sid} value={t.sid}>
              {t.friendlyName} ({t.language}) — {t.types.join(", ")}
            </option>
          ))}
        </select>
      </label>

      {templateSid === FREE_FORM ? (
        <label className="stack">
          <span className="muted">Body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Message body"
            required
          />
        </label>
      ) : selectedTemplate?.variables.length ? (
        <div className="stack">
          <span className="muted">Template variables</span>
          <div className="row">
            {selectedTemplate.variables.map((v) => (
              <label key={v} className="stack" style={{ flex: "1 1 160px" }}>
                <span className="muted">{`{{${v}}}`}</span>
                <input
                  value={vars[v] ?? ""}
                  onChange={(e) => setVars((prev) => ({ ...prev, [v]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="row" style={{ alignItems: "center" }}>
        <button type="submit" disabled={submitting || !from}>
          {submitting ? "Sending…" : "Send"}
        </button>
        {status && <span className="muted">{status}</span>}
      </div>
    </form>
  );
}
