"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@egghead/ui/button";

export function ShareProfileButton({ path }: { path: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  async function copyProfileLink() {
    window.clearTimeout(timeoutRef.current);

    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }

    timeoutRef.current = window.setTimeout(() => setCopyStatus("idle"), 1600);
  }

  const label =
    copyStatus === "copied"
      ? "Link copied"
      : copyStatus === "failed"
        ? "Copy failed"
        : "Copy public link";

  return (
    <Button aria-live="polite" onClick={copyProfileLink} size="sm" variant="ghost">
      {label}
    </Button>
  );
}
