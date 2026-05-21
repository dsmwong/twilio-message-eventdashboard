"use client";

import { useState } from "react";
import { AuthProvider, useAuth } from "../lib/auth";
import { ResourceModalProvider } from "../lib/useResourceModal";
import { AdminPanel } from "../components/AdminPanel";
import { Header } from "../components/Header";
import { HomeTabs } from "../components/HomeTabs";
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
      <HomeTabs />
    </div>
  );
}

export default function HomePage() {
  return (
    <AuthProvider>
      <ResourceModalProvider>
        <HomeBody />
      </ResourceModalProvider>
    </AuthProvider>
  );
}
