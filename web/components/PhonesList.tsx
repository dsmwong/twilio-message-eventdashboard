"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { PhoneIndex, PhoneIndexEntry } from "../lib/types";

type Row = PhoneIndexEntry & { value: string };

export function PhonesList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let doc: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["document"]>> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const client = await getSyncClient();
        doc = await client.document("phone_to_conversations");
        if (cancelled) return;
        const apply = (data: unknown) => {
          const numbers = (data as PhoneIndex)?.numbers ?? {};
          const list: Row[] = Object.entries(numbers).map(([value, entry]) => ({
            value,
            conversationIds: Array.isArray(entry.conversationIds) ? entry.conversationIds : [],
            lastActivityAt: entry.lastActivityAt ?? null,
          }));
          list.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
          setRows(list);
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        if ((e as { status?: number })?.status === 404) {
          setRows([]);
        } else {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      doc?.close();
    };
  }, []);

  if (err) return <p style={{ color: "tomato" }}>Error: {err}</p>;
  if (rows.length === 0) {
    return (
      <p className="muted">
        No customer phones captured yet. They populate as Conversation Orchestrator delivers
        statusCallbacks.
      </p>
    );
  }

  return (
    <table className="msg-table">
      <thead>
        <tr>
          <th>Phone</th>
          <th>Conversations</th>
          <th>Last activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isOpen = expanded === r.value;
          return (
            <Fragment key={r.value}>
              <tr
                onClick={() => setExpanded(isOpen ? null : r.value)}
                style={{ cursor: "pointer" }}
              >
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {isOpen ? "▾" : "▸"} {r.value}
                </td>
                <td>{r.conversationIds.length}</td>
                <td className="muted">
                  {r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleString() : "—"}
                </td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={3} style={{ background: "rgba(255,255,255,0.02)" }}>
                    <ul style={{ margin: 0, padding: "8px 16px", listStyle: "none" }}>
                      {r.conversationIds.map((id) => (
                        <li key={id} style={{ padding: "4px 0" }}>
                          <Link href={`/m/index.html?sid=${encodeURIComponent(id)}`}>{id}</Link>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
