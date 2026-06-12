"use client";

import Form from "next/form";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EggoMark } from "@egghead/ui/eggo-mark";
import { cn } from "@egghead/ui/utils";

/* Primary navigation from egghead-brand/navigation.html ("The Main Bar"):
   a floating tactile shelf — active page sits raised like the key you just
   pressed, search is a well, one yolk CTA per shelf. */

const NAV_LINKS = [
  { href: "/", label: "Learn" },
  { href: "/courses", label: "Courses" },
  { href: "/lessons", label: "Lessons" },
  { href: "/blog", label: "Articles" },
];

function isActive(pathname: string | null, href: string) {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

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

function EggIcon() {
  return (
    <svg height="17" viewBox="0 0 24 28" width="14">
      <path
        d="M12 1.5C7 1.5 3 9.5 3 16c0 6 3.8 10.5 9 10.5S21 22 21 16c0-6.5-4-14.5-9-14.5z"
        fill="var(--color-cream)"
        stroke="var(--color-yolk-shadow)"
        strokeWidth="2"
      />
    </svg>
  );
}

/* usePathname() counts as request data under cacheComponents, so the
   layout renders <SiteNav/> inside <Suspense fallback={<SiteNavView
   pathname={null}/>}> — same shelf, just no raised key until we know
   which page we're on. */
export function SiteNav() {
  const pathname = usePathname();

  return <SiteNavView pathname={pathname} />;
}

export function SiteNavView({ pathname }: { pathname: string | null }) {
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

          <span aria-hidden className="mx-0.5 hidden size-1.5 md:block" />

          <div className="hidden items-center gap-1.5 md:flex">
            {NAV_LINKS.map((link) => {
              const active = isActive(pathname, link.href);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-full text-sm",
                    active
                      ? "border border-border-strong bg-raised-grad px-4 py-2 font-extrabold text-foreground shadow-btn-ghost"
                      : "press px-4 py-2 font-bold text-muted-foreground hover:bg-(--hover-wash) hover:text-foreground",
                  )}
                  href={link.href}
                  key={link.href}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>

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

          <Link
            className="press hidden rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-5 pt-[11px] pb-[9px] text-sm font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover md:block"
            href="/login"
          >
            Sign in
          </Link>

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
            {NAV_LINKS.map((link) => {
              const active = isActive(pathname, link.href);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center rounded-xl px-4",
                    active
                      ? "gap-3 border border-border-strong bg-raised-grad pt-[13px] pb-[11px] font-extrabold text-foreground shadow-btn-ghost"
                      : "press justify-between py-3 font-bold text-muted-foreground hover:bg-(--hover-wash)",
                  )}
                  href={link.href}
                  key={link.href}
                >
                  {active ? <EggIcon /> : null}
                  {link.label}
                  {active ? null : <span className="font-black text-muted-foreground/40">→</span>}
                </Link>
              );
            })}

            <div className="my-2 border-t border-border-soft" />

            <Link
              className="press block rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-4 pt-[13px] pb-[11px] text-center font-extrabold text-yolk-foreground shadow-btn"
              href="/login"
            >
              Sign in
            </Link>
          </div>
        ) : null}
      </div>
    </header>
  );
}
