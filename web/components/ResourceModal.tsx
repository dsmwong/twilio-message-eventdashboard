"use client";

import { useEffect, useState } from "react";
import { resourceKindLabel } from "../lib/resourceId";

interface ResourceFetchResponse {
  kind?: string;
  id?: string;
  resource?: unknown;
  error?: string;
  upstream?: unknown;
}

export function ResourceModal({
  id,
  conversationId,
  onClose,
}: {
  id: string | null;
  conversationId?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ResourceFetchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Esc-to-close
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  // Fetch on open / id change
  useEffect(() => {
    if (!id) {
      setData(null);
      setError(null);
      setCopied(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setCopied(false);
    const params = new URLSearchParams({ id });
    if (conversationId) params.set("conversationId", conversationId);
    fetch(`/resource-fetch?${params.toString()}`, { credentials: "include" })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as ResourceFetchResponse;
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || `HTTP ${res.status}`);
        } else {
          setData(json);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, conversationId]);

  if (!id) return null;

  const json = data?.resource !== undefined ? JSON.stringify(data.resource, null, 2) : null;

  const copy = () => {
    if (!json || typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

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
        style={{
          width: 720,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
        }}
      >
        <div className="row" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>
              {resourceKindLabel(id)}
              <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                {id}
              </span>
            </h2>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {json && (
              <button
                type="button"
                onClick={copy}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--muted)",
                  fontWeight: 400,
                  fontSize: 12,
                  padding: "4px 10px",
                }}
                title="Copy JSON to clipboard"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--muted)",
                fontWeight: 400,
                fontSize: 12,
                padding: "4px 10px",
              }}
            >
              Close
            </button>
          </div>
        </div>

        {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
        {error && (
          <p style={{ color: "tomato", margin: 0, fontSize: 12 }}>
            Error: {error}
          </p>
        )}
        {json && (
          <pre
            style={{
              margin: 0,
              padding: 10,
              background: "rgba(0,0,0,0.35)",
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.45,
              overflow: "auto",
              flex: 1,
              minHeight: 200,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {json}
          </pre>
        )}
      </div>
    </div>
  );
}
