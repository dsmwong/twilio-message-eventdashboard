"use client";

import { useState } from "react";
import { ConversationList } from "./ConversationList";
import { MessageList } from "./MessageList";
import { PhonesList } from "./PhonesList";

type Tab = "messages" | "conversations" | "phones";

const TABS: { value: Tab; label: string }[] = [
  { value: "messages", label: "Messages" },
  { value: "conversations", label: "Conversations" },
  { value: "phones", label: "Phones" },
];

export function HomeTabs() {
  const [tab, setTab] = useState<Tab>("messages");

  return (
    <section className="panel stack">
      <div className="row" role="tablist" style={{ gap: 4, marginBottom: 4 }}>
        {TABS.map((t) => {
          const active = t.value === tab;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.value)}
              style={{
                background: active ? "var(--accent)" : "transparent",
                borderColor: active ? "var(--accent)" : "var(--border)",
                color: active ? "white" : "var(--fg)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">
        {tab === "messages" && <MessageList />}
        {tab === "conversations" && <ConversationList />}
        {tab === "phones" && <PhonesList />}
      </div>
    </section>
  );
}
