"use client";

import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import { createContext, useContext, useMemo, useRef, type ReactNode, type RefObject } from "react";

/* Shares the Mux player instance between the player island and the
   transcript island so transcript timestamps can seek the video. */
type MuxPlayerContextValue = {
  muxPlayerRef: RefObject<MuxPlayerRefAttributes | null>;
};

const MuxPlayerContext = createContext<MuxPlayerContextValue | null>(null);

export function MuxPlayerProvider({ children }: { children: ReactNode }) {
  const muxPlayerRef = useRef<MuxPlayerRefAttributes | null>(null);
  const value = useMemo(() => ({ muxPlayerRef }), []);

  return <MuxPlayerContext.Provider value={value}>{children}</MuxPlayerContext.Provider>;
}

export function useMuxPlayer() {
  return useContext(MuxPlayerContext);
}
