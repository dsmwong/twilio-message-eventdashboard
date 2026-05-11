"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { MessageRow } from "../lib/types";

type Row = MessageRow & { sid: string };

export function MessageList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let map: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["map"]>> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const client = await getSyncClient();
        map = await client.map("messages");
        if (cancelled) return;

        const initial: Row[] = [];
        let page: Awaited<ReturnType<NonNullable<typeof map>["getItems"]>> | null = await map.getItems({ pageSize: 100 });
        while (page) {
          for (const item of page.items) initial.push({ sid: item.key, ...(item.data as MessageRow) });
          page = page.hasNextPage ? await page.nextPage() : null;
        }
        const ts = (r: Row) => r.lastStatusAt ?? r.createdAt ?? "";
        initial.sort((a, b) => ts(b).localeCompare(ts(a)));
        setRows(initial);

        const tsOf = (r: Row) => r.lastStatusAt ?? r.createdAt ?? "";
        const bubble = (rows: Row[], next: Row) =>
          [next, ...rows.filter((r) => r.sid !== next.sid)].sort((a, b) => tsOf(b).localeCompare(tsOf(a)));
        map.on("itemAdded", ({ item }) =>
          setRows((prev) => bubble(prev, { sid: item.key, ...(item.data as MessageRow) }))
        );
        map.on("itemUpdated", ({ item }) =>
          setRows((prev) => bubble(prev, { sid: item.key, ...(item.data as MessageRow) }))
        );
        map.on("itemRemoved", ({ key }) => setRows((prev) => prev.filter((r) => r.sid !== key)));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      map?.close();
    };
  }, []);

  if (err) return <p style={{ color: "tomato" }}>Error: {err}</p>;
  if (rows.length === 0) return <p className="muted">No messages yet. Send one above.</p>;

  return (
    <table className="msg-table">
      <thead>
        <tr>
          <th>Message SID</th>
          <th>Dir</th>
          <th>Channel</th>
          <th>From</th>
          <th>To</th>
          <th>Opt-out</th>
          <th>Last status</th>
          <th>Last update</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sid}>
            <td>
              <Link href={`/m/?sid=${encodeURIComponent(r.sid)}`}>{r.sid}</Link>
            </td>
            <td>
              {r.direction === "in" ? (
                <span className="badge badge-in" title="Inbound">In</span>
              ) : r.direction === "out" ? (
                <span className="badge badge-out" title="Outbound">Out</span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              <span className="badge badge-sc">{r.channel}</span>
            </td>
            <td>{r.from}</td>
            <td>{r.to}</td>
            <td>
              {r.optOutType ? (
                <span className="badge badge-optout" title={`OptOutType: ${r.optOutType}`}>
                  {r.optOutType}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>{r.lastStatus ?? "—"}</td>
            <td className="muted">
              {r.lastStatusAt || r.createdAt
                ? new Date(r.lastStatusAt ?? r.createdAt ?? "").toLocaleString()
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
