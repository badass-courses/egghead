import { z } from "zod";

export const SEARCH_PAGE_SIZE = 24;

const cursorFields = {
  page: z.number().int().min(1).max(10_000),
  scope: z.string(),
};
const cursorSchema = z.discriminatedUnion("source", [
  z
    .object({
      ...cursorFields,
      source: z.literal("sql"),
      direction: z.enum(["next", "previous"]),
      boundary: z
        .object({ id: z.string().min(1).max(255), createdAt: z.iso.datetime() })
        .optional(),
    })
    .refine((cursor) =>
      cursor.page === 1 ? cursor.boundary === undefined : cursor.boundary !== undefined,
    ),
  z.object({ ...cursorFields, source: z.literal("typesense") }),
]);

export type SearchCursor = z.infer<typeof cursorSchema>;
export type SqlSearchCursor = Extract<SearchCursor, { source: "sql" }>;

export function encodeSearchCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeSearchCursor(value: string | undefined, scope: string): SearchCursor | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success && parsed.data.scope === scope ? parsed.data : null;
  } catch {
    return null;
  }
}

export function searchScope(term: string, type?: string | null, instructor?: string | null) {
  return JSON.stringify([term.trim(), type?.trim() || "", instructor?.trim() || ""]);
}

export type SearchPage<T> =
  | { kind: "stale-page" }
  | {
      kind: "page";
      results: T[];
      pagination: {
        page: number;
        total: number;
        totalPages: number;
        firstIndex: number;
        lastIndex: number;
        previousCursor: string | null;
        nextCursor: string | null;
      };
    };

// Both readers must satisfy this contract before the view receives pagination.
export function searchPage<T>(input: {
  results: T[];
  page: number;
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
}): SearchPage<T> {
  const { results, page, total, previousCursor, nextCursor } = input;
  const totalPages = Math.ceil(total / SEARCH_PAGE_SIZE);
  const firstIndex = total === 0 ? 0 : (page - 1) * SEARCH_PAGE_SIZE + 1;
  const lastIndex = results.length === 0 ? 0 : firstIndex + results.length - 1;
  const expectedLength = Math.min(
    SEARCH_PAGE_SIZE,
    Math.max(0, total - (page - 1) * SEARCH_PAGE_SIZE),
  );
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    (page > 1 && page > totalPages) ||
    results.length !== expectedLength ||
    Boolean(previousCursor) !== page > 1 ||
    Boolean(nextCursor) !== page < totalPages
  )
    return { kind: "stale-page" };
  return {
    kind: "page",
    results,
    pagination: { page, total, totalPages, firstIndex, lastIndex, previousCursor, nextCursor },
  };
}
