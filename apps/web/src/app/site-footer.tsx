import Link from "next/link";
import type { ReactNode } from "react";
import { EggoMark } from "@egghead/ui/eggo-mark";

/* Footer from egghead-brand/footer.html ("The Full Footer"): the bottom
   shelf — brand corner with social keycaps, quiet link columns with rust
   headers, warm bottom bar with the dumbwaiter back upstairs. */

const FOOTER_COLUMNS = [
  {
    label: "Learn",
    links: [
      { href: "/courses", label: "Courses" },
      { href: "/lessons", label: "Lessons" },
      { href: "/blog", label: "Articles" },
    ],
  },
  {
    label: "Watch & listen",
    links: [
      { href: "/podcasts", label: "Podcasts" },
      { href: "/talks", label: "Talks" },
    ],
  },
  {
    label: "Stories",
    links: [
      { href: "/case-studies", label: "Case studies" },
      { href: "/success-stories", label: "Success stories" },
      { href: "/campaigns", label: "Campaigns" },
      { href: "/q", label: "Browse everything →" },
    ],
  },
];

function SocialKey({
  children,
  href,
  label,
}: {
  children: ReactNode;
  href: string;
  label: string;
}) {
  return (
    <a
      aria-label={label}
      className="press grid size-10 place-items-center rounded-xl border border-border-strong bg-surface-grad text-muted-foreground shadow-btn-ghost"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

export function SiteFooter() {
  return (
    <div className="px-(--spacing-gutter) pb-10">
      <footer className="mx-auto max-w-[70rem] overflow-hidden rounded-2xl border bg-surface-grad shadow-card">
        <div className="grid gap-10 p-8 md:p-10 lg:grid-cols-[1.3fr_2fr]">
          <div className="space-y-4">
            <Link className="press inline-flex items-center gap-2.5 rounded-xl" href="/">
              <EggoMark className="drop-shadow-[0_3px_4px_rgba(0,0,0,0.25)]" size={40} />
              <span className="text-2xl font-black tracking-tight">egghead</span>
            </Link>
            <p className="rotate-[-1deg] font-hand text-2xl leading-none text-muted-foreground">
              learn by doing,
              <br />
              two minutes at a time.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <SocialKey href="https://github.com/eggheadio" label="GitHub">
                <svg fill="currentColor" height="17" viewBox="0 0 16 16" width="17">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </SocialKey>
              <SocialKey href="https://x.com/eggheadio" label="X">
                <svg fill="currentColor" height="14" viewBox="0 0 16 16" width="14">
                  <path d="M12.6 0h2.45l-5.35 6.12L16 16h-4.93l-3.86-5.05L2.8 16H.35l5.72-6.54L0 0h5.06l3.49 4.62L12.6 0zm-.86 14.53h1.36L4.32 1.39H2.86l8.88 13.14z" />
                </svg>
              </SocialKey>
              <SocialKey
                href="https://www.youtube.com/channel/UCdJrlj2GPlSD5MdRIxuUItA"
                label="YouTube"
              >
                <svg fill="currentColor" height="14" viewBox="0 0 20 14" width="18">
                  <path d="M19.6 2.2A2.5 2.5 0 0 0 17.8.4C16.2 0 10 0 10 0S3.8 0 2.2.4A2.5 2.5 0 0 0 .4 2.2 26 26 0 0 0 0 7a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 20 7a26 26 0 0 0-.4-4.8zM8 10V4l5.2 3L8 10z" />
                </svg>
              </SocialKey>
              <SocialKey href="/feed" label="RSS">
                <svg
                  fill="none"
                  height="15"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                  viewBox="0 0 16 16"
                  width="15"
                >
                  <circle cx="3" cy="13" fill="currentColor" r="1.5" stroke="none" />
                  <path d="M2 8a6 6 0 0 1 6 6" />
                  <path d="M2 3a11 11 0 0 1 11 11" />
                </svg>
              </SocialKey>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
            {FOOTER_COLUMNS.map((column) => (
              <nav aria-label={column.label} className="space-y-2.5" key={column.label}>
                <span className="eyebrow block">{column.label}</span>
                {column.links.map((link) => (
                  <Link
                    className="block rounded-md py-1 text-sm font-bold text-muted-foreground hover:text-foreground"
                    href={link.href}
                    key={link.href}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-border-soft bg-well-grad px-8 py-4 md:px-10">
          <span className="text-xs font-bold text-muted-foreground">© 2013–2026 egghead.io</span>
          <span className="rotate-[-1deg] font-hand text-lg text-muted-foreground/80">
            the egg does not crack 🥚
          </span>

          <nav
            aria-label="Legal"
            className="flex items-center gap-4 text-xs font-bold text-muted-foreground"
          >
            <a className="hover:text-foreground" href="https://egghead.io/terms">
              Terms
            </a>
            <a className="hover:text-foreground" href="https://egghead.io/privacy">
              Privacy
            </a>
          </nav>

          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-grad px-3 py-1.5 text-[11px] font-extrabold text-muted-foreground shadow-btn-ghost">
            <span
              aria-hidden
              className="size-2 rounded-full bg-sage shadow-[0_0_4px_var(--color-sage)]"
            />
            all systems sunny-side up
          </span>

          <a
            className="press inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-grad px-3.5 py-2 text-xs font-extrabold text-foreground shadow-btn-ghost"
            href="#top"
          >
            ↑ Back to top
          </a>
        </div>
      </footer>
    </div>
  );
}
