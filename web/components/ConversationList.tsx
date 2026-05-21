"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { getSyncClient } from "../lib/sync";
import type { MessageRow } from "../lib/types";
import { ViewResourceButton } from "./ViewResourceButton";

type Row = MessageRow & { sid: string };

function statusClass(status: string | undefined): string {
  const s = (status || "").toUpperCase();
  if (s === "ACTIVE") return "badge badge-status-active";
  if (s === "INACTIVE") return "badge badge-status-inactive";
  if (s === "CLOSED") return "badge badge-status-closed";
  return "badge";
}

export function ConversationList() {
  const { admin } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let map: Awaited<ReturnType<Awaited<ReturnType<typeof getSyncClient>>["map"]>> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const client = await getSyncClient();
        map = await client.map("messages");
        if (cancelled) return;

        const initial: Row[] = [];
        let page: Awaited<ReturnType<NonNullable<typeof map>["getItems"]>> | null = await map.getItems({
          pageSize: 100,
        });
        while (page) {
          for (const item of page.items) initial.push({ sid: item.key, ...(item.data as MessageRow) });
          page = page.hasNextPage ? await page.nextPage() : null;
        }
        const ts = (r: Row) => r.lastStatusAt ?? r.createdAt ?? "";
        initial.sort((a, b) => ts(b).localeCompare(ts(a)));
        setRows(initial);

        const bubble = (rows: Row[], next: Row) =>
          [next, ...rows.filter((r) => r.sid !== next.sid)].sort((a, b) =>
            (b.lastStatusAt ?? b.createdAt ?? "").localeCompare(a.lastStatusAt ?? a.createdAt ?? "")
          );
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

  async function transition(conversationId: string, status: "ACTIVE" | "INACTIVE" | "CLOSED") {
    const verb =
      status === "ACTIVE" ? "Reactivate" : status === "INACTIVE" ? "Mark inactive" : "Close";
    if (!confirm(`${verb} conversation ${conversationId}?`)) return;
    const key = `${conversationId}::${status}`;
    setClosing((p) => ({ ...p, [key]: true }));
    setActionError(null);
    try {
      const res = await fetch("/conversation-close", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, status }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `conversation-close ${res.status}`);
      // The CONVERSATION_INACTIVE / CONVERSATION_CLOSED callback will flow back
      // through /orchestrator-callback and update the row's lastStatus live.
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setClosing((p) => {
        const { [key]: _, ...rest } = p;
        return rest;
      });
    }
  }

  if (err) return <p style={{ color: "tomato" }}>Error: {err}</p>;
  const visible = rows.filter((r) => r.channel === "conversations");
  if (visible.length === 0) {
    return (
      <p className="muted">
        No conversations captured yet. Run <code>pnpm run conversations:bootstrap</code> and send a
        message to one of your Twilio numbers.
      </p>
    );
  }

  return (
    <>
      {actionError && <p style={{ color: "tomato", margin: "0 0 8px", fontSize: 12 }}>{actionError}</p>}
      <table className="conv-table">
        <thead>
          <tr>
            <th>Conversation ID</th>
            <th>Status</th>
            <th>Participants</th>
            <th>Last update</th>
            {admin && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const status = (r.lastStatus ?? "").toUpperCase();
            const closingFlight = Boolean(closing[`${r.sid}::CLOSED`]);
            const activateFlight = Boolean(closing[`${r.sid}::ACTIVE`]);
            const inactiveFlight = Boolean(closing[`${r.sid}::INACTIVE`]);
            const canClose = admin && status !== "CLOSED";
            // Active ↔ Inactive toggle: ACTIVE shows "Inactive", INACTIVE shows "Activate".
            const toggleTarget: "ACTIVE" | "INACTIVE" | null =
              status === "ACTIVE" ? "INACTIVE" : status === "INACTIVE" ? "ACTIVE" : null;
            const canToggle = admin && toggleTarget !== null;
            const toggleFlight = toggleTarget === "ACTIVE" ? activateFlight : inactiveFlight;
            return (
              <tr key={r.sid}>
                <td style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  <ViewResourceButton id={r.sid} />
                  <Link href={`/m/index.html?sid=${encodeURIComponent(r.sid)}`}>{r.sid}</Link>
                </td>
                <td>
                  {status ? (
                    <span className={statusClass(status)}>{status}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {(r.participantAddresses ?? []).length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <div className="pill-row">
                      {(r.participantAddresses ?? []).map((addr) => (
                        <span key={addr} className="badge badge-comms" style={{ fontSize: 11 }}>
                          {addr}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="muted">
                  {r.lastStatusAt || r.createdAt
                    ? new Date(r.lastStatusAt ?? r.createdAt ?? "").toLocaleString()
                    : "—"}
                </td>
                {admin && (
                  <td>
                    {canClose || canToggle ? (
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        {canToggle && toggleTarget && (
                          <button
                            type="button"
                            onClick={() => transition(r.sid, toggleTarget)}
                            disabled={toggleFlight}
                            style={{
                              fontSize: 11,
                              padding: "4px 8px",
                              background: "transparent",
                              border:
                                toggleTarget === "ACTIVE"
                                  ? "1px solid var(--sc)"
                                  : "1px solid var(--es)",
                              color: toggleTarget === "ACTIVE" ? "var(--sc)" : "var(--es)",
                              fontWeight: 400,
                            }}
                            title={
                              toggleTarget === "ACTIVE"
                                ? "Move conversation back to ACTIVE"
                                : "Move conversation to INACTIVE"
                            }
                          >
                            {toggleFlight ? "…" : toggleTarget === "ACTIVE" ? "Activate" : "Inactive"}
                          </button>
                        )}
                        {canClose && (
                          <button
                            type="button"
                            onClick={() => transition(r.sid, "CLOSED")}
                            disabled={closingFlight}
                            style={{
                              fontSize: 11,
                              padding: "4px 8px",
                              background: "transparent",
                              border: "1px solid var(--muted)",
                              color: "var(--fg)",
                              fontWeight: 400,
                            }}
                            title="Close this conversation"
                          >
                            {closingFlight ? "…" : "Close"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
