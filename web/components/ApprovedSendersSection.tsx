"use client";

import { useEffect, useMemo, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type {
  ApprovedSendersConfig,
  Channel,
  CommsSender,
  Sender,
  SendersConfig,
} from "../lib/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "rcs", label: "RCS" },
  { value: "comms", label: "Comms API" },
];

export function ApprovedSendersSection() {
  const [senders, setSenders] = useState<SendersConfig | null>(null);
  const [approved, setApproved] = useState<ApprovedSendersConfig | null>(null);
  const [commsCatalogue, setCommsCatalogue] = useState<CommsSender[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // value -> in-flight

  // Subscribe to senders catalogue (sms/whatsapp/rcs).
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

  // Fetch the Comms API sender catalogue (admin-only endpoint).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/comms-senders", { credentials: "include" });
        if (!res.ok) throw new Error(`comms-senders ${res.status}`);
        const json = (await res.json()) as { catalogue: CommsSender[] };
        if (!cancelled) setCommsCatalogue(json.catalogue ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(`comms-senders: ${e instanceof Error ? e.message : String(e)}`);
          setCommsCatalogue([]);
        }
      }
    })();
    return () => {
      cancelled = true;
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
            comms: Array.isArray(cfg.comms) ? cfg.comms : [],
          });
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        setError(`approved_senders: ${e instanceof Error ? e.message : String(e)}`);
        setApproved({ sms: [], whatsapp: [], rcs: [], comms: [] });
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
      comms: new Set(approved?.comms ?? []),
    };
  }, [approved]);

  /** Lookup map: comms sender address → upstream channel (SMS|RCS|WHATSAPP). */
  const commsChannelByValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of commsCatalogue ?? []) {
      if (c.value && c.channel) m.set(c.value, c.channel.toUpperCase());
    }
    return m;
  }, [commsCatalogue]);

  function listFor(channel: Channel): Sender[] {
    if (channel === "comms") {
      return (commsCatalogue ?? []).map<Sender>((c) => ({
        label: c.label,
        value: c.value,
        kind: "phone",
      }));
    }
    return senders?.[channel] ?? [];
  }

  function channelPillClass(ch: string): string {
    if (ch === "WHATSAPP") return "badge badge-channel-whatsapp";
    if (ch === "RCS") return "badge badge-channel-rcs";
    return "badge badge-channel-sms";
  }

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

  const loading = !senders || !approved || commsCatalogue === null;

  return (
    <section className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>Approved senders (From)</h3>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Tick the senders that are allowed for outbound. The Send form&apos;s From dropdown is filtered to approved entries only.
      </p>
      {error && <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {CHANNELS.map((c) => {
            const list: Sender[] = listFor(c.value);
            const set = approvedSets[c.value];
            const refreshHint =
              c.value === "comms"
                ? "Senders are loaded live from the Channels Senders API."
                : "No senders configured for this channel. Run `pnpm run refresh:senders`.";
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
                    {refreshHint}
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
                      const pillChannel =
                        c.value === "comms" ? commsChannelByValue.get(s.value) : undefined;
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
                          <span
                            style={{
                              fontSize: 12,
                              lineHeight: 1.3,
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {s.label}
                          </span>
                          {pillChannel && (
                            <span
                              className={channelPillClass(pillChannel)}
                              style={{ fontSize: 10 }}
                            >
                              {pillChannel}
                            </span>
                          )}
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
