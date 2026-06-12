"use client";

import { useEffect, type RefObject } from "react";

/*
 * Pause media when its page leaves the screen. With cacheComponents on,
 * navigating away doesn't detach the DOM — the router parks the last few
 * pages in hidden <Activity> boundaries (router bfcache), where attached
 * media keeps playing. Hiding does run effect cleanup, so pause here.
 * Covers real unmount too.
 */
export function usePauseWhenHidden(ref: RefObject<{ pause: () => void } | null>) {
  useEffect(() => {
    const media = ref.current;

    return () => {
      media?.pause();
    };
  }, [ref]);
}
