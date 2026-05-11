"use client";

import { SyncClient } from "twilio-sync";

let clientPromise: Promise<SyncClient> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch("/sync-token", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to fetch Sync token: ${res.status}`);
  const json = (await res.json()) as { token: string };
  return json.token;
}

export function getSyncClient(): Promise<SyncClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const token = await fetchToken();
    const client = new SyncClient(token);
    client.on("tokenAboutToExpire", async () => {
      try {
        const fresh = await fetchToken();
        await client.updateToken(fresh);
      } catch (err) {
        console.error("[sync] token refresh failed", err);
      }
    });
    return client;
  })();
  return clientPromise;
}
