"use client";

import { useResourceModal } from "../lib/useResourceModal";

/**
 * Compact "+" button that opens the ResourceModal for the given Twilio id.
 * Renders inline next to whatever existing affordance the row uses (typically
 * a Link that navigates to the timeline drilldown).
 */
export function ViewResourceButton({
  id,
  conversationId,
  title,
}: {
  id: string;
  conversationId?: string;
  title?: string;
}) {
  const { open } = useResourceModal();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(id, conversationId);
      }}
      title={title || `View resource JSON for ${id}`}
      style={{
        background: "transparent",
        border: "1px solid var(--border)",
        color: "var(--muted)",
        width: 18,
        height: 18,
        padding: 0,
        lineHeight: "16px",
        textAlign: "center",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 400,
        marginRight: 6,
        borderRadius: 3,
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    >
      +
    </button>
  );
}
