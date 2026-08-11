import Link from "next/link";

import type { ProfileCompletionFilter } from "../../profile/contracts";

export type CompletionFilterValue = "all" | ProfileCompletionFilter;

const completionFilters: readonly {
  label: string;
  value: CompletionFilterValue;
}[] = [
  { label: "All", value: "all" },
  { label: "Courses", value: "course" },
  { label: "Lessons", value: "lesson" },
];

export function completionFilterFromSearchParam(value: string | undefined): CompletionFilterValue {
  return value === "course" || value === "lesson" ? value : "all";
}

export function CompletionFilterControls({
  activeFilter,
  basePath,
}: {
  activeFilter: CompletionFilterValue;
  basePath: string;
}) {
  return (
    <nav aria-label="Filter completions" className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-extrabold text-muted-foreground">Show</span>
      {completionFilters.map((filter) => {
        const active = filter.value === activeFilter;
        const href = filter.value === "all" ? basePath : `${basePath}?completion=${filter.value}`;

        return (
          <Link
            aria-current={active ? "true" : undefined}
            className={`press inline-flex min-h-9 items-center rounded-lg border px-3 py-1.5 text-xs font-extrabold ${
              active
                ? "border-black/40 bg-navy-grad text-cream shadow-btn-navy"
                : "border-border-strong bg-surface-grad text-foreground shadow-btn-ghost"
            }`}
            href={href}
            key={filter.value}
            scroll={false}
          >
            {filter.label}
          </Link>
        );
      })}
    </nav>
  );
}
