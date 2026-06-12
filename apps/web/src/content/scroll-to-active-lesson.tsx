"use client";

import { useEffect, useRef } from "react";

/*
 * Centers the active lesson row inside the resource-list viewport. Lives
 * as an empty marker inside the viewport so it can find it via closest()
 * — the list itself stays a server component. Adjusts only the
 * container's scrollTop, never the page scroll (scrollIntoView could
 * move both). Re-runs per active lesson, including when the router
 * restores a bfcached page.
 */
export function ScrollToActiveLesson({ activeLessonSlug }: { activeLessonSlug?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeLessonSlug) return;

    const viewport = ref.current?.closest<HTMLElement>('[data-slot="resource-list-viewport"]');
    const active = viewport?.querySelector<HTMLElement>('[data-status="active"]');
    if (!viewport || !active) return;

    const viewportRect = viewport.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    // Center the row; the browser clamps to the scrollable range.
    viewport.scrollTop +=
      activeRect.top - viewportRect.top - (viewport.clientHeight - activeRect.height) / 2;
  }, [activeLessonSlug]);

  return <div ref={ref} hidden />;
}
