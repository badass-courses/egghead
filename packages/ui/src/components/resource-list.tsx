import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

import { cn } from "../utils";

/*
 * Tactile resource list from egghead-brand/resource-list.html (+ -dark).
 * Lessons sit in a raised card; sections are native <details> (no client
 * JS); the active lesson is a raised yolk key; completed/locked states are
 * quiet sage/padlock knobs. Compound parts compose freely; every part takes
 * className (tailwind-merge semantics) and exposes a data-slot hook.
 *
 * Status is a data-attribute variant, not boolean props — rows and
 * indicators read data-status, so progress can mark rows
 * completed/locked later without API changes.
 */

export type ResourceStatus = "active" | "completed" | "locked" | "upcoming";

type PolymorphicProps<T extends ElementType> = {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

function CheckIcon() {
  return (
    <svg
      aria-hidden
      width="11"
      height="9"
      viewBox="0 0 12 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 5.5L4.5 8.5L10.5 1.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      aria-hidden
      width="9"
      height="10"
      viewBox="0 0 13 14"
      fill="currentColor"
      className="translate-x-px"
    >
      <path d="M1 1.8c0-.8.9-1.3 1.6-.9l9 5.2c.7.4.7 1.4 0 1.8l-9 5.2c-.7.4-1.6-.1-1.6-.9V1.8z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden
      width="11"
      height="13"
      viewBox="0 0 12 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="1" y="6" width="10" height="7" rx="1.5" />
      <path d="M3.5 6V4a2.5 2.5 0 015 0v2" />
    </svg>
  );
}

/* ── Chevron: disclosure arrow for a section summary. A part rather than
   baked into the summary, so variants can omit or reposition it. ── */

export function ResourceListSectionChevron({
  className,
  ...props
}: ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      aria-hidden
      data-slot="resource-list-section-chevron"
      width="14"
      height="9"
      viewBox="0 0 14 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0 text-muted-foreground transition-transform duration-200 group-open/resource-section:rotate-180",
        className,
      )}
      {...props}
    >
      <path d="M1.5 1.5L7 7l5.5-5.5" />
    </svg>
  );
}

/* ── Card: the raised surface the curriculum lives on ── */

export function ResourceListCard({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="resource-list-card"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-surface-grad shadow-card-deep",
        className,
      )}
      {...props}
    />
  );
}

/* ── Viewport: scrollable inner area for a height-capped card. The card
   stays an opaque frame; only the content inside scrolls and fades, so
   the rounded border never gets masked away. Deliberately unrounded —
   border-radius on a scroll container clips its own scrollbar — the
   vertical inset keeps both content and scrollbar clear of the card's
   corner curves instead. ── */

export function ResourceListViewport({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="resource-list-viewport"
      className={cn("my-2 min-h-0 overflow-y-auto scroll-fade", className)}
      {...props}
    />
  );
}

/* ── Header: identity block pinned above the viewport, from the brand
   card header (eyebrow + title + meta; progress can join later). ── */

export function ResourceListHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="resource-list-header"
      className={cn("grid shrink-0 gap-1 border-b border-border-soft px-4 pb-3.5 pt-4", className)}
      {...props}
    />
  );
}

export function ResourceListHeaderEyebrow({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return (
    <p
      data-slot="resource-list-header-eyebrow"
      className={cn("m-0 text-[10px] font-black uppercase tracking-wider text-rust", className)}
      {...props}
    />
  );
}

export function ResourceListHeaderTitle<T extends ElementType = "h2">({
  as,
  className,
  ...props
}: PolymorphicProps<T>) {
  const Component = as ?? "h2";

  return (
    <Component
      data-slot="resource-list-header-title"
      className={cn("m-0 text-lg font-black leading-tight wrap-anywhere line-clamp-2", className)}
      {...props}
    />
  );
}

export function ResourceListHeaderMeta({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return (
    <p
      data-slot="resource-list-header-meta"
      className={cn("m-0 text-xs font-bold text-muted-foreground", className)}
      {...props}
    />
  );
}

/* ── Sections: native disclosure, open by default ── */

export function ResourceListSection({ className, ...props }: ComponentPropsWithoutRef<"details">) {
  return (
    <details
      data-slot="resource-list-section"
      className={cn(
        "group/resource-section border-b border-border-soft last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

export function ResourceListSectionSummary({
  className,
  ...props
}: ComponentPropsWithoutRef<"summary">) {
  return (
    <summary
      data-slot="resource-list-section-summary"
      className={cn(
        "flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 transition-colors hover:bg-(--hover-wash) [&::-webkit-details-marker]:hidden",
        className,
      )}
      {...props}
    />
  );
}

export function ResourceListSectionTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      data-slot="resource-list-section-title"
      className={cn("min-w-0 wrap-anywhere font-extrabold line-clamp-2", className)}
      {...props}
    />
  );
}

/* ── Badge: well-sunk count chip ("2/5") ── */

export function ResourceListBadge({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      data-slot="resource-list-badge"
      className={cn(
        "shrink-0 rounded-full border border-border-strong bg-well px-2.5 py-1 text-xs font-extrabold text-muted-foreground shadow-well",
        className,
      )}
      {...props}
    />
  );
}

/* ── Label: uppercase eyebrow for lists outside a card ── */

export function ResourceListLabel<T extends ElementType = "h3">({
  as,
  className,
  ...props
}: PolymorphicProps<T>) {
  const Component = as ?? "h3";

  return (
    <Component
      data-slot="resource-list-label"
      className={cn(
        "m-0 px-2 text-xs font-extrabold uppercase leading-tight tracking-[0.14em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/* ── The list and its rows ── */

export function ResourceList({ className, ...props }: ComponentPropsWithoutRef<"ol">) {
  return (
    <ol
      data-slot="resource-list"
      className={cn("m-0 grid list-none gap-1 p-0 px-3.5 pb-3", className)}
      {...props}
    />
  );
}

export function ResourceListItem({ className, ...props }: ComponentPropsWithoutRef<"li">) {
  return <li data-slot="resource-list-item" className={cn("m-0", className)} {...props} />;
}

const linkStatus: Record<ResourceStatus, string> = {
  upcoming: "hover:bg-(--hover-wash)",
  completed: "text-muted-foreground hover:bg-(--hover-wash)",
  active:
    "press border border-yolk-shadow/40 bg-yolk-grad py-2.5 font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover",
  locked: "opacity-55 text-muted-foreground",
};

export function ResourceListLink<T extends ElementType = "a">({
  as,
  status = "upcoming",
  className,
  ...props
}: PolymorphicProps<T> & { status?: ResourceStatus }) {
  const classes = cn(
    "group/resource flex items-center gap-3 rounded-xl px-2.5 py-2 text-inherit no-underline transition-colors",
    linkStatus[status],
    className,
  );

  if (status === "locked") {
    // A locked row is not a link: no href to follow, nothing to focus.
    const { children } = props as { children?: ReactNode };

    return (
      <span data-slot="resource-list-link" data-status="locked" className={classes}>
        {children}
      </span>
    );
  }

  const Component = as ?? "a";

  return (
    <Component
      data-slot="resource-list-link"
      data-status={status}
      aria-current={status === "active" ? "page" : undefined}
      className={classes}
      {...props}
    />
  );
}

/* ── Indicator: the knob at the start of every row ── */

const indicatorStatus: Record<ResourceStatus, string> = {
  upcoming: "border-border-strong bg-well text-muted-foreground shadow-well",
  completed: "border-sage-line bg-sage-wash text-sage-foreground",
  active: "border-border-strong bg-surface-grad text-foreground shadow-knob",
  locked: "border-border-strong bg-well text-muted-foreground shadow-well",
};

export function ResourceListIndicator({
  index,
  status = "upcoming",
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  index?: number;
  status?: ResourceStatus;
}) {
  return (
    <span
      data-slot="resource-list-indicator"
      data-status={status}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full border text-[11px] font-black",
        indicatorStatus[status],
        className,
      )}
      {...props}
    >
      {status === "completed" ? (
        <CheckIcon />
      ) : status === "active" ? (
        <PlayIcon />
      ) : status === "locked" ? (
        <LockIcon />
      ) : index !== undefined ? (
        index + 1
      ) : null}
    </span>
  );
}

export function ResourceListTitle({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      data-slot="resource-list-title"
      className={cn("min-w-0 wrap-anywhere font-bold line-clamp-2", className)}
      {...props}
    />
  );
}

export function ResourceListMeta({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      data-slot="resource-list-meta"
      className={cn(
        "ml-auto shrink-0 text-xs font-bold text-muted-foreground",
        "group-data-[status=active]/resource:font-extrabold group-data-[status=active]/resource:text-inherit",
        className,
      )}
      {...props}
    />
  );
}
