"use client";

import { useState } from "react";
import { useAuth } from "../lib/auth";
import { AdminLoginModal } from "./AdminLoginModal";

export function Header({ onManageAdmins }: { onManageAdmins: () => void }) {
  const { admin, loading, logout } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <header className="row" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
      <div>
        <h1 style={{ margin: 0 }}>Messaging Event Dashboard</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          StatusCallback vs Event Streams, side-by-side.
        </p>
      </div>
      <div className="row" style={{ alignItems: "center", gap: 12, fontSize: 12 }}>
        {loading ? (
          <span className="muted">…</span>
        ) : admin ? (
          <>
            <span className="muted">
              Signed in as <strong style={{ color: "var(--fg)" }}>{admin.name}</strong>
            </span>
            <button
              type="button"
              onClick={onManageAdmins}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--fg)",
                fontSize: 12,
                padding: "4px 10px",
              }}
            >
              Manage admins
            </button>
            <button
              type="button"
              onClick={() => logout()}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--muted)",
                fontSize: 12,
                padding: "4px 10px",
              }}
            >
              Logout
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setLoginOpen(true)}
            style={{
              background: "transparent",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
              fontSize: 12,
              padding: "4px 10px",
            }}
          >
            Admin login
          </button>
        )}
      </div>
      {loginOpen && <AdminLoginModal onClose={() => setLoginOpen(false)} />}
    </header>
  );
}
