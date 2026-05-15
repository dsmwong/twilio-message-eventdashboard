"use client";

import { useState } from "react";

type Step = "request" | "confirm";

const VERIFY_CHANNELS = [
  { value: "sms", label: "SMS" },
  { value: "call", label: "Voice call" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

async function jsonRequest(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: { error?: string } & Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

export function AddDestinationModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("request");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [channel, setChannel] = useState<(typeof VERIFY_CHANNELS)[number]["value"]>("sms");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function startVerification() {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await jsonRequest("/verify-start", { label, value, channel });
    setBusy(false);
    if (!ok) {
      setError(data.error || "failed to send code");
      return;
    }
    setStep("confirm");
    setInfo(`Code sent to ${value} via ${channel}.`);
  }

  async function resendCode() {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await jsonRequest("/verify-start", { label, value, channel });
    setBusy(false);
    if (!ok) {
      setError(data.error || "failed to resend code");
      return;
    }
    setInfo(`Code re-sent to ${value}.`);
  }

  async function confirmCode() {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await jsonRequest("/verify-confirm", { value, code });
    setBusy(false);
    if (!ok) {
      setError(data.error || "code did not match");
      return;
    }
    onClose();
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
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel stack"
        style={{ width: 400, maxWidth: "calc(100vw - 32px)" }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Add approved destination</h2>
        {step === "request" ? (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              We&apos;ll send a 6-digit code to confirm you control this number before adding it
              to the allowlist.
            </p>
            <label className="stack">
              <span className="muted">Label</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My phone"
                autoFocus
                required
              />
            </label>
            <label className="stack">
              <span className="muted">Phone number (E.164)</span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="+15551234567"
                inputMode="tel"
                required
              />
            </label>
            <label className="stack">
              <span className="muted">Channel</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                {VERIFY_CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Enter the 6-digit code sent to <strong style={{ color: "var(--fg)" }}>{value}</strong>.
            </p>
            <label className="stack">
              <span className="muted">Code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
          </>
        )}

        {info && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{info}</p>}
        {error && <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>{error}</p>}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)" }}
          >
            Cancel
          </button>
          {step === "request" ? (
            <button type="button" onClick={startVerification} disabled={busy || !label || !value}>
              {busy ? "Sending…" : "Send code"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={resendCode}
                disabled={busy}
                style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--accent)" }}
              >
                Resend
              </button>
              <button type="button" onClick={confirmCode} disabled={busy || code.length < 4}>
                {busy ? "Verifying…" : "Verify & add"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
