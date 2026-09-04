"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@egghead/ui/button";

export function TeamInviteLink({
  disabled,
  email,
  url,
}: {
  disabled: boolean;
  email: string;
  url: string;
}) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
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
      <label className="text-sm font-extrabold" htmlFor={inputId}>
        Team invite link
      </label>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          aria-describedby={helpId}
          aria-label={`Invitation link for ${email}`}
          className="h-12 min-w-0 rounded-xl border border-border-strong bg-well px-4 text-sm font-semibold text-foreground shadow-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          id={inputId}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={url}
        />
        <Button aria-live="polite" disabled={disabled} onClick={copyInviteLink} type="button">
          {buttonLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" id={helpId}>
        Only {email} can accept this invitation, once, before it expires.
      </p>
    </div>
  );
}
