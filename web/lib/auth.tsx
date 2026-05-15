"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface AdminSession {
  name: string;
}

interface AuthValue {
  admin: AdminSession | null;
  loading: boolean;
  error: string | null;
  login: (name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function jsonRequest(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty/invalid body */
  }
  return { res, body } as { res: Response; body: { error?: string; name?: string } | null };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { res, body } = await jsonRequest("/admin-me");
      if (res.ok && body && typeof body.name === "string") {
        setAdmin({ name: body.name });
      } else {
        setAdmin(null);
      }
    } catch {
      setAdmin(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (name: string, password: string) => {
    setError(null);
    const { res, body } = await jsonRequest("/admin-login", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) {
      const msg = body?.error || `login failed (${res.status})`;
      setError(msg);
      throw new Error(msg);
    }
    setAdmin({ name: body!.name as string });
  }, []);

  const logout = useCallback(async () => {
    await jsonRequest("/admin-logout", { method: "POST" });
    setAdmin(null);
  }, []);

  return (
    <AuthContext.Provider value={{ admin, loading, error, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
