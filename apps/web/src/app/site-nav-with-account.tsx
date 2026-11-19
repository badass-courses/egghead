"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { parseNavAccountState, type NavAccountState } from "../coursebuilder/nav-account";
import { SiteNavView } from "./site-nav";

// The account state loads in the browser so the root layout never reads the
// session on the server; see src/coursebuilder/nav-account.ts for why.
// Until it arrives the nav shows the same "unknown" state as the old
// streamed Suspense fallback.
export function SiteNavWithAccount() {
  const pathname = usePathname();
  const [state, setState] = useState<NavAccountState | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/nav-account", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const parsed = parseNavAccountState(body);
        if (parsed) setState(parsed);
        return parsed;
      })
      .catch(() => {
        // Aborted or offline: keep the current state.
      });

    return () => controller.abort();
  }, [pathname]);

  if (!state) return <SiteNavView accountState="unknown" pathname={pathname} />;

  if (state.displayName === null) {
    return <SiteNavView accountState="anonymous" pathname={pathname} />;
  }

  return (
    <SiteNavView
      account={{ displayName: state.displayName, hasProSubscription: state.hasProSubscription }}
      accountState="authenticated"
      pathname={pathname}
    />
  );
}
