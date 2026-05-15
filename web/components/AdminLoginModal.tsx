"use client";

import { useState } from "react";
import { useAuth } from "../lib/auth";

export function AdminLoginModal({ onClose }: { onClose: () => void }) {
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(name, password);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="panel stack"
        style={{ width: 360, maxWidth: "calc(100vw - 32px)" }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Admin login</h2>
        <label className="stack">
          <span className="muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label className="stack">
          <span className="muted">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <span style={{ color: "tomato", fontSize: 12 }}>{error}</span>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
          >
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name || !password}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
