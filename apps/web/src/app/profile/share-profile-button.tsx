"use client";

import { useState } from "react";
import { Button } from "@egghead/ui/button";

export function ShareProfileButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  async function copyProfileLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${path}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Button aria-live="polite" onClick={copyProfileLink} size="sm" variant="ghost">
      {copied ? "Link copied" : "Copy public link"}
    </Button>
  );
}
