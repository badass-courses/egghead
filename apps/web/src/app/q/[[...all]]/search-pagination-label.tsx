"use client";

import { useLinkStatus } from "next/link";

// Cold searches can take seconds; acknowledge the click while the next page loads.
export function SearchPaginationLabel({ children }: { children: string }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-live="polite" data-search-pagination-pending={pending || undefined}>
      {pending ? "Loading…" : children}
    </span>
  );
}
