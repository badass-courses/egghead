"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@egghead/ui/button";

export function TeamInviteLink({ disabled, url }: { disabled: boolean; url: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  async function copyInviteLink() {
    window.clearTimeout(timeoutRef.current);

    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }

    timeoutRef.current = window.setTimeout(() => setCopyStatus("idle"), 1600);
  }

  const buttonLabel =
    copyStatus === "copied" ? "Link copied" : copyStatus === "failed" ? "Copy failed" : "Copy link";

  return (
    <div className="mt-5 grid gap-2">
      <label className="text-sm font-extrabold" htmlFor="team-invite-link">
        Team invite link
      </label>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          aria-describedby="team-invite-link-help"
          aria-label="Team invite link"
          className="h-12 min-w-0 rounded-xl border border-border-strong bg-well px-4 text-sm font-semibold text-foreground shadow-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          id="team-invite-link"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={url}
        />
        <Button aria-live="polite" disabled={disabled} onClick={copyInviteLink} type="button">
          {buttonLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" id="team-invite-link-help">
        Anyone with this link can claim one of your available seats.
      </p>
    </div>
  );
}
