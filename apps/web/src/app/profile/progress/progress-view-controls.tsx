import Link from "next/link";
import { Button } from "@egghead/ui/button";

import type { CompletionFilterValue } from "../completion-filter-controls";
import { progressHref, type ProgressRouteState } from "./progress-query";

const completionFilters: readonly { label: string; value: CompletionFilterValue }[] = [
  { label: "Everything", value: "all" },
  { label: "Courses", value: "course" },
  { label: "Lessons", value: "lesson" },
];

const orderOptions: readonly {
  label: string;
  value: ProgressRouteState["order"];
}[] = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
];

export function ProgressViewControls({ state }: { state: ProgressRouteState }) {
  const hasActiveView =
    state.completion !== "all" || state.search.length > 0 || state.order !== "newest";

  return (
    <aside aria-labelledby="progress-controls-heading" className="lg:sticky-rail lg:self-start">
      <div className="rounded-2xl bg-surface-grad p-5 shadow-card sm:p-6">
        <h2 className="text-xl font-black tracking-tight" id="progress-controls-heading">
          View your record
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Narrow the list or change its order.</p>

        <nav aria-label="Filter progress by type" className="mt-6">
          <p className="text-xs font-extrabold text-muted-foreground">Resource type</p>
          <div className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-3 lg:grid-cols-1">
            {completionFilters.map((filter) => {
              const active = filter.value === state.completion;

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`press inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-extrabold lg:justify-start ${
                    active
                      ? "border-black/40 bg-navy-grad text-cream shadow-btn-navy"
                      : "border-border-strong bg-surface-grad text-foreground shadow-btn-ghost"
                  }`}
                  href={progressHref(state, { completion: filter.value, page: 1 })}
                  key={filter.value}
                  scroll={false}
                >
                  {filter.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <nav aria-label="Change completion order" className="mt-6">
          <p className="text-xs font-extrabold text-muted-foreground">Order</p>
          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-1">
            {orderOptions.map((option) => {
              const active = option.value === state.order;

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`press inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-extrabold lg:justify-start ${
                    active
                      ? "border-black/40 bg-navy-grad text-cream shadow-btn-navy"
                      : "border-border-strong bg-surface-grad text-foreground shadow-btn-ghost"
                  }`}
                  href={progressHref(state, { order: option.value, page: 1 })}
                  key={option.value}
                  scroll={false}
                >
                  {option.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <form action="/profile/progress" className="mt-6 grid gap-5">
          {state.completion !== "all" ? (
            <input
              aria-label="Resource type"
              name="completion"
              type="hidden"
              value={state.completion}
            />
          ) : null}
          {state.order !== "newest" ? (
            <input aria-label="Completion order" name="order" type="hidden" value={state.order} />
          ) : null}
          <label className="grid gap-2 text-sm font-extrabold" htmlFor="progress-search">
            Find by title
            <input
              aria-label="Find completions by title"
              className="h-11 min-w-0 rounded-xl border border-border-strong bg-well px-3.5 text-foreground shadow-well outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              defaultValue={state.search}
              id="progress-search"
              maxLength={100}
              name="q"
              placeholder="Search titles"
              type="search"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" type="submit">
              Search
            </Button>
            {hasActiveView ? (
              <Link
                className="text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                href="/profile/progress"
              >
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      </div>
    </aside>
  );
}
