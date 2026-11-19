"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  ANONYMOUS_NAV_ACCOUNT,
  parseNavAccountState,
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
// so the nav never sits on "Account" forever. It refetches on navigation and
// when the window regains focus (for example after signing out in another
// tab).
export function SiteNavWithAccount() {
  const pathname = usePathname();
  const [state, setState] = useState<NavAccountState | null>(null);

  useEffect(() => {
    let controller = new AbortController();

    const load = () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      readNavAccount(signal)
        .then((account) => {
          if (!signal.aborted) setState(account);
          return account;
        })
        .catch(() => {
          if (!signal.aborted) setState(ANONYMOUS_NAV_ACCOUNT);
        });
    };

    load();
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      controller.abort();
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
