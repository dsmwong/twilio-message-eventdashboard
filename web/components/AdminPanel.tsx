"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminInfo } from "../lib/types";
import { useAuth } from "../lib/auth";
import { ApprovedDestinationsSection } from "./ApprovedDestinationsSection";
import { ApprovedSendersSection } from "./ApprovedSendersSection";

type Mode = null | { kind: "add" } | { kind: "rotate"; name: string };

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const { admin: me } = useAuth();
  const [admins, setAdmins] = useState<AdminInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/admin-list", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `admin-list ${res.status}`);
      setAdmins(json.admins as AdminInfo[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function call(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${path} ${res.status}`);
      await load();
      setMode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!confirm(`Remove admin "${name}"?`)) return;
    await call("/admin-remove", { name });
  }

  return (
    <section className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Manage admins</h2>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" onClick={() => setMode({ kind: "add" })} disabled={busy}>
            Add admin
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
          >
            Close
          </button>
        </div>
      </div>

      {error && <p style={{ color: "tomato", margin: 0 }}>{error}</p>}

      {!admins ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th style={{ width: 200 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.name}>
                <td>
                  <strong>{a.name}</strong>
                  {me?.name === a.name && <span className="muted" style={{ marginLeft: 6 }}>(you)</span>}
                </td>
                <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setMode({ kind: "rotate", name: a.name })}
                      style={{ fontSize: 12, padding: "2px 8px" }}
                    >
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(a.name)}
                      disabled={a.name === me?.name || admins.length <= 1 || busy}
                      title={a.name === me?.name ? "Can't remove yourself" : admins.length <= 1 ? "Last admin" : ""}
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
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {mode?.kind === "add" && (
        <CredentialForm
          title="Add admin"
          requireName
          onCancel={() => setMode(null)}
          onSubmit={(name, password) => call("/admin-create", { name, password })}
          busy={busy}
        />
      )}
      {mode?.kind === "rotate" && (
        <CredentialForm
          title={`Rotate password for ${mode.name}`}
          fixedName={mode.name}
          onCancel={() => setMode(null)}
          onSubmit={(_n, password) => call("/admin-rotate", { name: mode.name, password })}
          busy={busy}
        />
      )}

      <ApprovedDestinationsSection />
      <ApprovedSendersSection />
    </section>
  );
}

function CredentialForm({
  title,
  requireName,
  fixedName,
  onCancel,
  onSubmit,
  busy,
}: {
  title: string;
  requireName?: boolean;
  fixedName?: string;
  onCancel: () => void;
  onSubmit: (name: string, password: string) => Promise<void> | void;
  busy: boolean;
}) {
  const [name, setName] = useState(fixedName ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setErr(null);
    if (password !== confirm) {
      setErr("passwords do not match");
      return;
    }
    if (password.length < 8) {
      setErr("password must be at least 8 characters");
      return;
    }
    await onSubmit(name, password);
  }

  return (
    <form onSubmit={submit} className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
      {requireName && (
        <label className="stack">
          <span className="muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      )}
      <label className="stack">
        <span className="muted">Password (8+ chars)</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <label className="stack">
        <span className="muted">Confirm password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      {err && <span style={{ color: "tomato", fontSize: 12 }}>{err}</span>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)" }}
        >
          Cancel
        </button>
        <button type="submit" disabled={busy || (requireName && !name) || !password}>
          Save
        </button>
      </div>
    </form>
  );
}
