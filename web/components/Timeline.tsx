"use client";

import { useEffect, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { EventRow } from "../lib/types";

export function Timeline({ sid }: { sid: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let list: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["list"]>> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const client = await getSyncClient();
        list = await client.list(`events:${sid}`);
        if (cancelled) return;

        const initial: EventRow[] = [];
        let page: Awaited<ReturnType<NonNullable<typeof list>["getItems"]>> | null = await list.getItems({
          pageSize: 100,
        });
        while (page) {
          for (const item of page.items) initial.push(item.data as EventRow);
          page = page.hasNextPage ? await page.nextPage() : null;
        }
        setEvents(initial);

        list.on("itemAdded", ({ item }) => setEvents((prev) => [...prev, item.data as EventRow]));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      list?.close();
    };
  }, [sid]);

  if (err) return <p style={{ color: "tomato" }}>Error: {err}</p>;

  const sorted = [...events].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  const earliest = sorted.length ? new Date(sorted[0].timestamp).getTime() : 0;
  const isCommsOperation = sid.startsWith("comms_operation_");

  if (isCommsOperation) {
    const op = sorted.filter((e) => e.eventType?.startsWith("com.twilio.comms-api.operation"));
    const cm = sorted.filter((e) => e.eventType?.startsWith("com.twilio.comms-api.message"));
    const mm = sorted.filter((e) => e.eventType?.startsWith("com.twilio.messaging.message"));
    const known = new Set([...op, ...cm, ...mm]);
    const other = sorted.filter((e) => !known.has(e));
    return (
      <div className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="badge badge-op">Operation ({op.length})</span>
          <span className="badge badge-es">Comms API · Message ({cm.length})</span>
          <span className="badge badge-sc">Messaging · Message ({mm.length})</span>
          {other.length > 0 && <span className="badge">Other ({other.length})</span>}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: other.length > 0 ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr",
            gap: 12,
          }}
        >
          <Column title="Operation" kind="op" events={op} earliest={earliest} />
          <Column title="Comms API · Message" kind="es" events={cm} earliest={earliest} />
          <Column title="Messaging · Message" kind="sc" events={mm} earliest={earliest} />
          {other.length > 0 && <Column title="Other" kind="op" events={other} earliest={earliest} />}
        </div>
      </div>
    );
  }

  const sc = sorted.filter((e) => e.source === "status-callback");
  const es = sorted.filter((e) => e.source === "event-stream");
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="badge badge-sc">StatusCallback ({sc.length})</span>
        <span className="badge badge-es">Event Streams ({es.length})</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Column title="StatusCallback" kind="sc" events={sc} earliest={earliest} />
        <Column title="Event Streams" kind="es" events={es} earliest={earliest} />
      </div>
    </div>
  );
}

type ColumnKind = "op" | "sc" | "es";

const KIND_VAR: Record<ColumnKind, string> = {
  op: "var(--op)",
  sc: "var(--sc)",
  es: "var(--es)",
};

function Column({
  title,
  kind,
  events,
  earliest,
}: {
  title: string;
  kind: ColumnKind;
  events: EventRow[];
  earliest: number;
}) {
  const borderColor = KIND_VAR[kind];
  return (
    <div>
      <h3>{title}</h3>
      {events.length === 0 && <p className="muted">No events yet.</p>}
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map((e, idx) => {
          const t = new Date(e.timestamp).getTime();
          const delta = t - earliest;
          return (
            <li
              key={`${kind}-${idx}-${e.timestamp}`}
              style={{
                padding: 10,
                marginBottom: 8,
                borderLeft: `3px solid ${borderColor}`,
                background: "rgba(255,255,255,0.02)",
                borderRadius: 4,
              }}
            >
              <div style={{ fontWeight: 600 }}>{e.eventType}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {new Date(e.timestamp).toISOString()} (+{delta}ms)
              </div>
              <PayloadTable payload={e.payload} />
              {e.source === "event-stream" && e.envelope && <EnvelopeJson envelope={e.envelope} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function PayloadTable({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
        {entries.length} parameter{entries.length === 1 ? "" : "s"}
      </summary>
      <table style={{ marginTop: 6, fontSize: 12, tableLayout: "fixed", width: "100%" }}>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td
                style={{
                  padding: "4px 8px",
                  color: "var(--muted)",
                  verticalAlign: "top",
                  width: "40%",
                  wordBreak: "break-word",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {k}
              </td>
              <td
                style={{
                  padding: "4px 8px",
                  verticalAlign: "top",
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {formatValue(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function EnvelopeJson({ envelope }: { envelope: Record<string, unknown> }) {
  const json = JSON.stringify(envelope, null, 2);
  const copy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(json).catch(() => {});
    }
  };
  return (
    <details style={{ marginTop: 6 }}>
      <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
        CloudEvent envelope (full JSON)
      </summary>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={copy}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            fontSize: 11,
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--muted)",
            fontWeight: 400,
          }}
          title="Copy JSON to clipboard"
        >
          copy
        </button>
        <pre
          style={{
            marginTop: 6,
            padding: 10,
            background: "rgba(0,0,0,0.35)",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.45,
            overflow: "auto",
            maxHeight: 400,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {json}
        </pre>
      </div>
    </details>
  );
}
