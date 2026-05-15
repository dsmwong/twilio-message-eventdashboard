"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Timeline } from "../../components/Timeline";

function MessageDetail() {
  const params = useSearchParams();
  const sid = params.get("sid") ?? "";
  return (
    <div className="container stack">
      <header>
        <Link href="/index.html">← back</Link>
        <h1 style={{ margin: "8px 0 0", fontSize: 20 }}>{sid || "(no message selected)"}</h1>
      </header>
      {sid ? <Timeline sid={sid} /> : <p className="muted">Append ?sid=MM... to the URL.</p>}
    </div>
  );
}

export default function MessageDetailPage() {
  return (
    <Suspense fallback={<div className="container">Loading…</div>}>
      <MessageDetail />
    </Suspense>
  );
}
