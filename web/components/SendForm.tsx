"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { getSyncClient } from "../lib/sync";
import type {
  ApprovedNumber,
  ApprovedSendersConfig,
  ApprovedToConfig,
  Channel,
  CommsSender,
  Sender,
  SendersConfig,
  TemplateSummary,
} from "../lib/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "rcs", label: "RCS" },
  { value: "comms", label: "Comms API (bulk)" },
];

const FREE_FORM = "__free__";

export function SendForm() {
  const { admin, loading: authLoading } = useAuth();
  const [channel, setChannel] = useState<Channel>("sms");
  const [senders, setSenders] = useState<SendersConfig | null>(null);
  const [approvedSenders, setApprovedSenders] = useState<ApprovedSendersConfig | null>(null);
  const [approved, setApproved] = useState<ApprovedNumber[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [commsCatalogue, setCommsCatalogue] = useState<CommsSender[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [toMulti, setToMulti] = useState<string[]>([]);
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

  // Approved-Senders Sync Document subscription.
  useEffect(() => {
    let doc: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["document"]>> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const client = await getSyncClient();
        doc = await client.document("approved_senders");
        if (cancelled) return;
        const apply = (d: unknown) => {
          const cfg = (d as Partial<ApprovedSendersConfig>) || {};
          setApprovedSenders({
            sms: Array.isArray(cfg.sms) ? cfg.sms : [],
            whatsapp: Array.isArray(cfg.whatsapp) ? cfg.whatsapp : [],
            rcs: Array.isArray(cfg.rcs) ? cfg.rcs : [],
            comms: Array.isArray(cfg.comms) ? cfg.comms : [],
          });
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        // Treat missing document as "nothing approved".
        setApprovedSenders({ sms: [], whatsapp: [], rcs: [], comms: [] });
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

  // Lazily fetch the Comms API sender catalogue when first needed (admin-only).
  useEffect(() => {
    if (channel !== "comms" || !admin || commsCatalogue) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/comms-senders", { credentials: "include" });
        if (!res.ok) throw new Error(`comms-senders ${res.status}`);
        const json = (await res.json()) as { catalogue: CommsSender[] };
        if (!cancelled) setCommsCatalogue(json.catalogue ?? []);
      } catch (e) {
        if (!cancelled) {
          setCommsCatalogue([]);
          setStatus(`Failed to load Comms API senders: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, admin, commsCatalogue]);

  const channelSenders: Sender[] = useMemo(() => {
    if (channel === "comms") {
      const all = (commsCatalogue ?? []).map<Sender>((c) => ({
        label: c.channel ? `${c.label} [${c.channel}]` : c.label,
        value: c.value,
        kind: "phone",
      }));
      if (!approvedSenders) return all;
      const set = new Set(approvedSenders.comms ?? []);
      return all.filter((s) => set.has(s.value));
    }
    const all = senders ? senders[channel] ?? [] : [];
    if (!approvedSenders) return all; // not yet loaded — don't strip
    const set = new Set(approvedSenders[channel] ?? []);
    return all.filter((s) => set.has(s.value));
  }, [senders, approvedSenders, channel, commsCatalogue]);

  const channelTemplates = useMemo(
    () => (templates ?? []).filter((t) => t.channels.includes(channel as "sms" | "whatsapp" | "rcs")),
    [templates, channel]
  );

  useEffect(() => {
    setFrom(channelSenders[0]?.value ?? "");
  }, [channelSenders]);

  useEffect(() => {
    if (channel === "sms" || channel === "comms") return;
    if (templateSid === FREE_FORM) setTemplateSid(channelTemplates[0]?.sid ?? "");
  }, [channel, channelTemplates, templateSid]);

  // Reset destination when allowlist changes / first loads.
  useEffect(() => {
    if (approved && approved.length > 0 && !approved.some((n) => n.value === to)) {
      setTo(approved[0].value);
    }
  }, [approved, to]);

  // Drop multi-select picks that disappear from the allowlist.
  useEffect(() => {
    if (!approved) return;
    const allowed = new Set(approved.map((n) => n.value));
    setToMulti((prev) => prev.filter((v) => allowed.has(v)));
  }, [approved]);

  const selectedTemplate = channelTemplates.find((t) => t.sid === templateSid);
  const isViewer = !authLoading && !admin;
  const allowlistEmpty = approved !== null && approved.length === 0;
  const noApprovedSendersForChannel =
    approvedSenders !== null && (approvedSenders[channel]?.length ?? 0) === 0;
  const isComms = channel === "comms";

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      if (isComms) {
        if (toMulti.length === 0) throw new Error("pick at least one recipient");
        const res = await fetch("/send-comms", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: toMulti, body }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `send-comms ${res.status}`);
        setStatus(`Sent operation: ${json.operationId} (${json.recipientCount} recipients)`);
        return;
      }

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

  const sendDisabled =
    submitting ||
    !from ||
    (isComms ? toMulti.length === 0 || !body : !to);

  return (
    <form onSubmit={submit} className="stack">
      {isViewer && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          🔒 Sign in as an administrator to send messages.
        </p>
      )}
      {admin && allowlistEmpty && (
        <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>
          The approved destinations list is empty. Add one in <strong>Manage admins → Approved destinations</strong>.
        </p>
      )}
      {admin && !allowlistEmpty && noApprovedSendersForChannel && (
        <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>
          No approved senders for {channel}. Tick one in <strong>Manage admins → Approved senders</strong>.
        </p>
      )}
      <fieldset
        disabled={isViewer || allowlistEmpty || noApprovedSendersForChannel}
        style={{
          border: "none",
          padding: 0,
          margin: 0,
          opacity: isViewer || allowlistEmpty || noApprovedSendersForChannel ? 0.55 : 1,
        }}
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
            {!isComms && (
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
            )}
          </div>

          {isComms && (
            <label className="stack">
              <span className="muted">
                Recipients ({toMulti.length} selected) — Cmd/Ctrl-click to pick multiple
              </span>
              <select
                multiple
                value={toMulti}
                onChange={(e) =>
                  setToMulti(Array.from(e.target.selectedOptions).map((o) => o.value))
                }
                size={Math.min(8, Math.max(3, (approved ?? []).length))}
              >
                {(approved ?? []).map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label} ({n.value})
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isComms && (
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
          )}

          {isComms || templateSid === FREE_FORM ? (
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
            <button type="submit" disabled={sendDisabled}>
              {submitting ? "Sending…" : isComms ? `Send to ${toMulti.length}` : "Send"}
            </button>
            {status && <span className="muted">{status}</span>}
          </div>
        </div>
      </fieldset>
    </form>
  );
}
