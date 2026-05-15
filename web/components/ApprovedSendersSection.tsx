"use client";

import { useEffect, useMemo, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { ApprovedSendersConfig, Channel, Sender, SendersConfig } from "../lib/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "rcs", label: "RCS" },
];

export function ApprovedSendersSection() {
  const [senders, setSenders] = useState<SendersConfig | null>(null);
  const [approved, setApproved] = useState<ApprovedSendersConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // value -> in-flight

  // Subscribe to senders catalogue.
  useEffect(() => {
    let doc: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["document"]>> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const client = await getSyncClient();
        doc = await client.document("senders");
        if (cancelled) return;
        const apply = (d: unknown) => setSenders((d as SendersConfig) ?? { sms: [], whatsapp: [], rcs: [] });
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        setError(`senders: ${e instanceof Error ? e.message : String(e)}`);
        setSenders({ sms: [], whatsapp: [], rcs: [] });
      }
    })();
    return () => {
      cancelled = true;
      doc?.close();
    };
  }, []);

  // Subscribe to approved senders.
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
          setApproved({
            sms: Array.isArray(cfg.sms) ? cfg.sms : [],
            whatsapp: Array.isArray(cfg.whatsapp) ? cfg.whatsapp : [],
            rcs: Array.isArray(cfg.rcs) ? cfg.rcs : [],
          });
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        setError(`approved_senders: ${e instanceof Error ? e.message : String(e)}`);
        setApproved({ sms: [], whatsapp: [], rcs: [] });
      }
    })();
    return () => {
      cancelled = true;
      doc?.close();
    };
  }, []);

  const approvedSets = useMemo(() => {
    return {
      sms: new Set(approved?.sms ?? []),
      whatsapp: new Set(approved?.whatsapp ?? []),
      rcs: new Set(approved?.rcs ?? []),
    };
  }, [approved]);

  async function toggle(channel: Channel, value: string, currentlyApproved: boolean) {
    if (!approved) return;
    setPending((p) => ({ ...p, [value]: true }));
    setError(null);
    const nextValues = currentlyApproved
      ? approved[channel].filter((v) => v !== value)
      : [...approved[channel], value];
    try {
      const res = await fetch("/senders-approved-set", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, values: nextValues }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `senders-approved-set ${res.status}`);
      // Live subscription will refresh `approved`.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((p) => {
        const { [value]: _, ...rest } = p;
        return rest;
      });
    }
  }

  return (
    <section className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>Approved senders (From)</h3>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Tick the senders that are allowed for outbound. The Send form&apos;s From dropdown is filtered to approved entries only.
      </p>
      {error && <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>{error}</p>}

      {!senders || !approved ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {CHANNELS.map((c) => {
            const list: Sender[] = senders[c.value] ?? [];
            const set = approvedSets[c.value];
            return (
              <div key={c.value} className="stack" style={{ gap: 6 }}>
                <strong style={{ fontSize: 13 }}>
                  {c.label}{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    ({set.size} of {list.length} approved)
                  </span>
                </strong>
                {list.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    No senders configured for this channel. Run <code>pnpm run refresh:senders</code>.
                  </p>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                      gap: 4,
                    }}
                  >
                    {list.map((s) => {
                      const isApproved = set.has(s.value);
                      const inFlight = Boolean(pending[s.value]);
                      return (
                        <label
                          key={s.value}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "4px 6px",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: inFlight ? "wait" : "pointer",
                            opacity: inFlight ? 0.6 : 1,
                            background: "transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isApproved}
                            disabled={inFlight}
                            onChange={() => toggle(c.value, s.value, isApproved)}
                            style={{ margin: 0 }}
                          />
                          <span style={{ fontSize: 12, lineHeight: 1.3 }}>{s.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
