"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { getSyncClient } from "../lib/sync";
import type { ApprovedNumber, ApprovedToConfig, Channel, Sender, SendersConfig, TemplateSummary } from "../lib/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "rcs", label: "RCS" },
];

const FREE_FORM = "__free__";

export function SendForm() {
  const { admin, loading: authLoading } = useAuth();
  const [channel, setChannel] = useState<Channel>("sms");
  const [senders, setSenders] = useState<SendersConfig | null>(null);
  const [approved, setApproved] = useState<ApprovedNumber[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [templateSid, setTemplateSid] = useState<string>(FREE_FORM);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Templates load eagerly — no auth needed for the read-only list.
  useEffect(() => {
    fetch("/templates")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`templates ${r.status}`))))
      .then((json: { templates: TemplateSummary[] }) => setTemplates(json.templates))
      .catch((e) => setStatus(`Failed to load templates: ${e.message}`));
  }, []);

  // Senders Sync Document subscription.
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

  // Approved-To Sync Document subscription.
  useEffect(() => {
    let doc: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["document"]>> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const client = await getSyncClient();
        doc = await client.document("approved_to");
        if (cancelled) return;
        const apply = (d: unknown) => {
          const cfg = (d as ApprovedToConfig) ?? null;
          setApproved(Array.isArray(cfg?.numbers) ? cfg!.numbers : []);
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        // Treat missing document as "empty allowlist".
        setApproved([]);
        // Surface only if the user is an admin (viewers don't need this hint).
        if (admin) {
          setStatus(
            `Approved-To Sync Document missing or unreadable: ${
              e instanceof Error ? e.message : String(e)
            }. Run \`pnpm run refresh:approved\`.`
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      doc?.close();
    };
  }, [admin]);

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

  // Reset destination when allowlist changes / first loads.
  useEffect(() => {
    if (approved && approved.length > 0 && !approved.some((n) => n.value === to)) {
      setTo(approved[0].value);
    }
  }, [approved, to]);

  const selectedTemplate = channelTemplates.find((t) => t.sid === templateSid);
  const isViewer = !authLoading && !admin;
  const allowlistEmpty = approved !== null && approved.length === 0;

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
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `send ${res.status}`);
      setStatus(`Sent: ${json.sid}`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      {isViewer && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          🔒 Sign in as an administrator to send messages.
        </p>
      )}
      {admin && allowlistEmpty && (
        <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>
          The approved destinations list is empty. Run <code>pnpm run refresh:approved</code> to seed it before sending.
        </p>
      )}
      <fieldset
        disabled={isViewer || allowlistEmpty}
        style={{ border: "none", padding: 0, margin: 0, opacity: isViewer || allowlistEmpty ? 0.55 : 1 }}
      >
        <div className="stack">
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
              <span className="muted">To (approved destinations)</span>
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                {(approved ?? []).length === 0 && <option value="">No approved destinations</option>}
                {(approved ?? []).map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label} ({n.value})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="stack">
            <span className="muted">Template</span>
            <select value={templateSid} onChange={(e) => setTemplateSid(e.target.value)}>
              {channel === "sms" && <option value={FREE_FORM}>Free-form body</option>}
              {channelTemplates.length === 0 && channel !== "sms" && (
                <option value="">No templates for {channel}</option>
              )}
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
            <button type="submit" disabled={submitting || !from || !to}>
              {submitting ? "Sending…" : "Send"}
            </button>
            {status && <span className="muted">{status}</span>}
          </div>
        </div>
      </fieldset>
    </form>
  );
}
