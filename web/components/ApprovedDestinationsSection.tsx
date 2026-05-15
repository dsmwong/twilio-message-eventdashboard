"use client";

import { useEffect, useState } from "react";
import { getSyncClient } from "../lib/sync";
import type { ApprovedNumber, ApprovedToConfig } from "../lib/types";
import { AddDestinationModal } from "./AddDestinationModal";

export function ApprovedDestinationsSection() {
  const [numbers, setNumbers] = useState<ApprovedNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

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
          setNumbers(Array.isArray(cfg?.numbers) ? cfg!.numbers : []);
        };
        apply(doc.data);
        doc.on("updated", ({ data }) => apply(data));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setNumbers([]);
      }
    })();
    return () => {
      cancelled = true;
      doc?.close();
    };
  }, []);

  async function remove(value: string, label: string) {
    if (!confirm(`Remove "${label}" (${value}) from the approved destinations?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/approved-remove", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `approved-remove ${res.status}`);
      // The Sync subscription will refresh `numbers` for us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Approved destinations</h3>
        <button type="button" onClick={() => setAdding(true)} disabled={busy}>
          Add destination
        </button>
      </div>

      {error && <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>{error}</p>}

      {!numbers ? (
        <p className="muted">Loading…</p>
      ) : numbers.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No approved destinations yet. Click <strong>Add destination</strong> to verify and add one.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Value</th>
              <th>Verified</th>
              <th style={{ width: 110 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.value}>
                <td>{n.label}</td>
                <td>
                  <code style={{ fontSize: 12 }}>{n.value}</code>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {n.verifiedAt ? (
                    <>
                      ✓ {new Date(n.verifiedAt).toLocaleDateString()}
                      {n.verifiedBy && <> by {n.verifiedBy}</>}
                    </>
                  ) : (
                    <span style={{ fontStyle: "italic" }}>legacy</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => remove(n.value, n.label)}
                    disabled={busy}
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      background: "transparent",
                      border: "1px solid tomato",
                      color: "tomato",
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && <AddDestinationModal onClose={() => setAdding(false)} />}
    </section>
  );
}
