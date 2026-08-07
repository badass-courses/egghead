import {
  completionFilterFromSearchParam,
  type CompletionFilterValue,
} from "../completion-filter-controls";

export type ProgressOrder = "newest" | "oldest";

export type ProgressRouteState = {
  completion: CompletionFilterValue;
  order: ProgressOrder;
  page: number;
  search: string;
};

export type ProgressSearchParams = {
  completion?: string;
  order?: string;
  page?: string;
  q?: string;
};

export function progressRouteStateFromSearchParams(
  searchParams: ProgressSearchParams,
): ProgressRouteState {
  const parsedPage = Number.parseInt(searchParams.page ?? "1", 10);

  return {
    completion: completionFilterFromSearchParam(searchParams.completion),
    order: searchParams.order === "oldest" ? "oldest" : "newest",
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    search: searchParams.q?.trim().slice(0, 100) ?? "",
  };
}

export function progressHref(
  state: ProgressRouteState,
  overrides: Partial<ProgressRouteState> = {},
) {
  const next = { ...state, ...overrides };
  const query = new URLSearchParams();

  if (next.completion !== "all") query.set("completion", next.completion);
  if (next.search) query.set("q", next.search);
  if (next.order !== "newest") query.set("order", next.order);
  if (next.page > 1) query.set("page", String(next.page));

  const suffix = query.toString();
  return suffix ? `/profile/progress?${suffix}` : "/profile/progress";
}
