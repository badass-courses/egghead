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
      <output className="text-sm font-semibold text-muted-foreground">
        Activation is taking longer than usual. You can leave this page open or contact{" "}
        <a
          className="font-extrabold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
          href="mailto:support@egghead.io"
        >
          support@egghead.io
        </a>
        .
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
