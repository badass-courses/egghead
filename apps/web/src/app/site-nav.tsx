"use client";

import Form from "next/form";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EggoMark } from "@egghead/ui/eggo-mark";
import { cn } from "@egghead/ui/utils";

/* Primary navigation from egghead-brand/navigation.html ("The Main Bar"):
   a floating tactile shelf with search and account access. */

export type SiteAccountState = "authenticated" | "anonymous" | "unknown";

type SiteNavAccount = {
  displayName: string;
  hasProSubscription: boolean;
};

function SearchIcon() {
  return (
    <svg
      fill="none"
      height="15"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 17 17"
      width="15"
    >
      <circle cx="7" cy="7" r="5.5" />
      <path d="M11.5 11.5L15.5 15.5" />
    </svg>
  );
}

/* The layout streams pathname and account state through one Suspense
   boundary. Its fallback keeps the same shelf visible without claiming
   the visitor is signed in or signed out before the request resolves. */
export function SiteNav({
  account,
  accountState,
}: {
  account?: SiteNavAccount;
  accountState: SiteAccountState;
}) {
  const pathname = usePathname();

  return (
    <SiteNavView
      accountState={accountState}
      pathname={pathname}
      {...(account ? { account } : {})}
    />
  );
}

function AccountLink({
  account,
  accountState,
  mobile = false,
}: {
  account?: SiteNavAccount;
  accountState: SiteAccountState;
  mobile?: boolean;
}) {
  const authenticated = accountState === "authenticated";
  const anonymous = accountState === "anonymous";
  const accountName = account?.displayName || "Profile";
  const proLabel = account?.hasProSubscription ? "Pro" : "Free";

  return (
    <Link
      className={cn(
        "press rounded-xl text-sm font-extrabold",
        mobile
          ? "flex items-center justify-center gap-2 px-4 pt-[13px] pb-[11px] text-center"
          : "hidden items-center gap-2 px-5 pt-[11px] pb-[9px] md:flex",
        anonymous
          ? "border border-yolk-shadow/40 bg-yolk-grad text-yolk-foreground shadow-btn hover:shadow-btn-hover"
          : "border border-border-strong bg-raised-grad text-foreground shadow-btn-ghost",
      )}
      href="/profile"
      aria-label={authenticated ? `Your profile, ${accountName}, ${proLabel} account` : undefined}
      prefetch={false}
    >
      {authenticated ? (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-sage shadow-[0_0_4px_var(--color-sage)]"
        />
      ) : null}
      {authenticated ? (
        <span className="grid min-w-0 text-left leading-tight">
          <span className="max-w-[8rem] truncate">{accountName}</span>
          <span className="text-[0.65rem] font-black uppercase tracking-[0.12em] text-muted-foreground">
            {proLabel}
          </span>
        </span>
      ) : (
        <span>{anonymous ? "Sign in" : "Account"}</span>
      )}
    </Link>
  );
}

export function SiteNavView({
  account,
  accountState,
  pathname,
}: {
  account?: SiteNavAccount;
  accountState: SiteAccountState;
  pathname: string | null;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();

        // Focus the nav search where it exists (desktop); otherwise go
        // to the search page, which focuses its own input.
        const input = searchRef.current;
        if (input && input.offsetParent !== null) {
          input.focus();
          input.select();
        } else {
          router.push("/q");
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <header className="sticky top-3 z-40 mt-3 px-(--spacing-gutter)">
      <div className="relative mx-auto max-w-[70rem]">
        <nav
          aria-label="Primary"
          className="flex items-center gap-2.5 rounded-2xl border bg-surface-grad py-3 pr-3 pl-4 shadow-card"
        >
          <Link className="press flex items-center gap-1 rounded-xl pr-1.5" href="/">
            <EggoMark className="drop-shadow-[0_3px_4px_rgba(0,0,0,0.25)]" size={34} />
            <span className="text-xl font-black tracking-tight">egghead</span>
          </Link>

          <Form
            action="/q"
            className="ml-auto hidden w-56 items-center gap-2.5 rounded-full border border-border-strong bg-well px-4 py-2 text-muted-foreground shadow-well focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring lg:flex"
          >
            <SearchIcon />
            <input
              aria-label="Search egghead"
              className="w-full min-w-0 bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-foreground/35"
              name="q"
              placeholder="Search…"
              ref={searchRef}
            />
            <kbd className="ml-auto rounded-md border border-border-strong bg-surface-grad px-1.5 py-0.5 text-[10px] font-extrabold text-muted-foreground shadow-btn-ghost">
              ⌘K
            </kbd>
          </Form>

          <Link
            aria-label="Search"
            className="press ml-auto grid size-10 place-items-center rounded-xl border border-border-strong bg-surface-grad text-muted-foreground shadow-btn-ghost lg:hidden"
            href="/q"
          >
            <SearchIcon />
          </Link>

          <AccountLink accountState={accountState} {...(account ? { account } : {})} />

          <button
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className={cn(
              "grid size-10 place-items-center rounded-xl border md:hidden",
              menuOpen
                ? "border-border-strong bg-well font-black text-foreground shadow-well"
                : "press border-yolk-shadow/40 bg-yolk-grad shadow-btn",
            )}
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            {menuOpen ? (
              "✕"
            ) : (
              <span className="block space-y-1">
                <span className="block h-[2.5px] w-[18px] rounded-full bg-yolk-foreground" />
                <span className="block h-[2.5px] w-[18px] rounded-full bg-yolk-foreground" />
                <span className="block h-[2.5px] w-[12px] rounded-full bg-yolk-foreground" />
              </span>
            )}
          </button>
        </nav>

        {menuOpen ? (
          <div className="absolute inset-x-0 top-[calc(100%+0.75rem)] space-y-1.5 rounded-2xl border bg-surface-grad p-3 shadow-card-deep md:hidden">
            <AccountLink accountState={accountState} mobile {...(account ? { account } : {})} />
          </div>
        ) : null}
      </div>
    </header>
  );
}
