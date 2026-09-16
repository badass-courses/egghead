"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 15;

export function MembershipStatusRefresh() {
  const router = useRouter();
  const [pollingExpired, setPollingExpired] = useState(false);

  useEffect(() => {
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      router.refresh();

      if (attempts >= MAX_POLL_ATTEMPTS) {
        window.clearInterval(interval);
        setPollingExpired(true);
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [router]);

  if (pollingExpired) {
    return (
      <output className="grid justify-items-center gap-3 text-sm font-semibold text-muted-foreground">
        <span>
          Activation is taking longer than usual. Reload the page or contact{" "}
          <a
            className="font-extrabold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
            href="mailto:support@egghead.io"
          >
            support@egghead.io
          </a>
          .
        </span>
        <button
          className="press rounded-xl border border-border-strong bg-surface-grad px-4 py-2 font-extrabold text-foreground shadow-btn-ghost"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload status
        </button>
      </output>
    );
  }

  return (
    <output
      aria-label="Waiting for membership activation"
      className="flex items-center justify-center gap-2 text-sm font-semibold text-muted-foreground"
    >
      <span
        aria-hidden
        className="size-2.5 animate-pulse rounded-full bg-yolk motion-reduce:animate-none"
      />
      This page updates automatically.
    </output>
  );
}
