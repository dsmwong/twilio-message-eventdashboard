"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ResourceModal } from "../components/ResourceModal";

interface OpenRequest {
  id: string;
  conversationId?: string;
}

interface Ctx {
  openId: string | null;
  conversationId: string | undefined;
  open: (id: string, conversationId?: string) => void;
  close: () => void;
}

const ResourceModalContext = createContext<Ctx | null>(null);

export function ResourceModalProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const open = useCallback((id: string, conversationId?: string) => {
    setRequest({ id, conversationId });
  }, []);
  const close = useCallback(() => setRequest(null), []);

  const value: Ctx = {
    openId: request?.id ?? null,
    conversationId: request?.conversationId,
    open,
    close,
  };

  return (
    <ResourceModalContext.Provider value={value}>
      {children}
      <ResourceModal id={value.openId} conversationId={value.conversationId} onClose={close} />
    </ResourceModalContext.Provider>
  );
}

export function useResourceModal(): Ctx {
  const ctx = useContext(ResourceModalContext);
  if (!ctx) {
    throw new Error("useResourceModal must be used inside <ResourceModalProvider>");
  }
  return ctx;
}
