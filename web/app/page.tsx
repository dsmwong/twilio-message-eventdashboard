"use client";

import { useState } from "react";
import { AuthProvider, useAuth } from "../lib/auth";
import { AdminPanel } from "../components/AdminPanel";
import { Header } from "../components/Header";
import { MessageList } from "../components/MessageList";
import { SendForm } from "../components/SendForm";

function HomeBody() {
  const { admin } = useAuth();
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);

  return (
    <div className="container stack">
      <Header onManageAdmins={() => setAdminPanelOpen((v) => !v)} />
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Send test message</h2>
        <SendForm />
      </section>
      {admin && adminPanelOpen && <AdminPanel onClose={() => setAdminPanelOpen(false)} />}
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Recent messages</h2>
        <MessageList />
      </section>
    </div>
  );
}

export default function HomePage() {
  return (
    <AuthProvider>
      <HomeBody />
    </AuthProvider>
  );
}
