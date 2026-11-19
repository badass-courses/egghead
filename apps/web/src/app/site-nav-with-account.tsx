"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  ANONYMOUS_NAV_ACCOUNT,
  parseNavAccountState,
  shouldRefreshNavAccount,
  type NavAccountState,
} from "../coursebuilder/nav-account";
import { SiteNavView } from "./site-nav";

async function readNavAccount(signal: AbortSignal): Promise<NavAccountState> {
  const response = await fetch("/api/nav-account", { cache: "no-store", signal });
  if (!response.ok) return ANONYMOUS_NAV_ACCOUNT;
  return parseNavAccountState(await response.json()) ?? ANONYMOUS_NAV_ACCOUNT;
}

// The account state loads in the browser so no layout reads the session on
// the server; see src/coursebuilder/nav-account.ts for why. Until it arrives
// the nav shows the same "unknown" state as the old streamed Suspense
// fallback. A failed or malformed response falls back to the anonymous nav,
// so the nav never sits on "Account" forever.
//
// It loads once per document, then refreshes on navigation or window focus
// at most once every NAV_ACCOUNT_REFRESH_MS (one minute). Sign-in and
// sign-out are full page loads, so they always start fresh.
export function SiteNavWithAccount() {
  const pathname = usePathname();
  const [state, setState] = useState<NavAccountState | null>(null);
  const lastStartedAt = useRef<number | null>(null);

  useEffect(() => {
    let inFlight: AbortController | null = null;

    const load = () => {
      const now = Date.now();
      if (inFlight || !shouldRefreshNavAccount(lastStartedAt.current, now)) return;
      lastStartedAt.current = now;
      const current = new AbortController();
      inFlight = current;
      readNavAccount(current.signal)
        .then((account) => {
          if (!current.signal.aborted) setState(account);
          return account;
        })
        .catch(() => {
          if (!current.signal.aborted) setState(ANONYMOUS_NAV_ACCOUNT);
        })
        .finally(() => {
          if (inFlight === current) inFlight = null;
        });
    };

    load();
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      if (inFlight) {
        // An unfinished load does not count, so the next effect retries.
        inFlight.abort();
        inFlight = null;
        lastStartedAt.current = null;
      }
    };
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
