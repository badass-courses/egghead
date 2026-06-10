export type SearchRouteParams = {
  all?: string[];
};

export type SearchRouteSearchParams = {
  q?: string | string[];
  type?: string | string[];
};

export function firstSearchParamValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function decodeSearchSegment(value: string) {
  const plusAsSpace = value.replaceAll("+", " ");

  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

function normalizeSearchTerm(value: string) {
  return decodeSearchSegment(value).replace(/\s+/g, " ").trim();
}

export function searchTermFromRoute(input: {
  params: SearchRouteParams;
  searchParams: SearchRouteSearchParams;
}) {
  const queryTerm = normalizeSearchTerm(firstSearchParamValue(input.searchParams.q));
  if (queryTerm) return queryTerm;

  return normalizeSearchTerm(input.params.all?.join(" ") ?? "");
}

export function contentTypeFromSearchParams(searchParams: SearchRouteSearchParams) {
  return firstSearchParamValue(searchParams.type).trim();
}
