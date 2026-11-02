import assert from "node:assert/strict";
import { test } from "node:test";
import {
  searchPage,
  decodeSearchCursor,
  encodeSearchCursor,
} from "../apps/web/src/content/search-pagination";

void test("one pagination contract covers empty, exact, partial, and middle pages", () => {
  for (const [page, total, length, previousCursor, nextCursor, firstIndex, lastIndex] of [
    [1, 0, 0, null, null, 0, 0],
    [1, 24, 24, null, null, 1, 24],
    [1, 25, 24, null, "next", 1, 24],
    [2, 25, 1, "previous", null, 25, 25],
    [2, 48, 24, "previous", null, 25, 48],
    [2, 49, 24, "previous", "next", 25, 48],
    [3, 49, 1, "previous", null, 49, 49],
  ] as const) {
    const result = searchPage({
      results: Array.from({ length }, (_, i) => i),
      page,
      total,
      previousCursor,
      nextCursor,
    });
    assert.equal(result.kind, "page");
    if (result.kind !== "page") throw new Error("Expected a page");
    assert.equal(result.pagination.firstIndex, firstIndex);
    assert.equal(result.pagination.lastIndex, lastIndex);
    assert.equal(result.pagination.totalPages, Math.ceil(total / 24));
  }
});

void test("contradictory counts, positions, and navigation are stale instead of repaired", () => {
  for (const input of [
    { page: 3, total: 25, length: 1, previousCursor: "previous", nextCursor: null },
    { page: 2, total: 49, length: 24, previousCursor: "previous", nextCursor: null },
    { page: 2, total: 48, length: 23, previousCursor: "previous", nextCursor: null },
    { page: 1, total: 24, length: 24, previousCursor: null, nextCursor: "next" },
    { page: 2, total: 48, length: 0, previousCursor: "previous", nextCursor: null },
    { page: 1, total: -1, length: 0, previousCursor: null, nextCursor: null },
  ]) {
    assert.deepEqual(
      searchPage({ ...input, results: Array.from({ length: input.length }, (_, i) => i) }),
      { kind: "stale-page" },
    );
  }
});

void test("SQL positions require a boundary after page one; native positions need only a page", () => {
  assert.equal(
    decodeSearchCursor(
      encodeSearchCursor({ source: "sql", page: 2, scope: "scope", direction: "next" }),
      "scope",
    ),
    null,
  );
  assert.equal(
    decodeSearchCursor(
      encodeSearchCursor({
        source: "sql",
        page: 1,
        scope: "scope",
        direction: "previous",
        boundary: { id: "synthetic", createdAt: "2030-01-01T00:00:00.000Z" },
      }),
      "scope",
    ),
    null,
  );
  assert.deepEqual(
    decodeSearchCursor(
      encodeSearchCursor({ source: "typesense", page: 2, scope: "scope" }),
      "scope",
    ),
    { source: "typesense", page: 2, scope: "scope" },
  );
});
