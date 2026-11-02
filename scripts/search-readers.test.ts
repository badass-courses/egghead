import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { searchContentPage as ReadPage } from "../apps/web/src/content/search";
import type { ContentResourceForSearch } from "../apps/web/src/content/search-document";
import { encodeSearchCursor, searchScope } from "../apps/web/src/content/search-pagination";

const appRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const modulePath = (name: string) => new URL(`../apps/web/src/${name}`, import.meta.url).pathname;
const originalEnv = { ...process.env };
const rows = Array.from({ length: 49 }, (_, i) => ({
  id: `synthetic-${String(49 - i).padStart(3, "0")}`,
  type: "article",
  // Ties require the unique ID as the second ordering column.
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
  updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  fields: { title: `Fixture ${i}`, slug: `fixture-${i}`, state: "published", visibility: "public" },
})) satisfies ContentResourceForSearch[];
let catalog = rows;
let totalOverride: number | null = null;
let resolutions = 0;
const statements: { sql: string; params: readonly unknown[] }[] = [];
const nativeRequests: URL[] = [];

mock.module(modulePath("db/local-docker.ts"), {
  namedExports: {
    createLocalMysqlConnection: async () => ({
      query: async () => [[{ Field: "slug" }], []],
      execute: async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.includes("COUNT(*) AS total"))
          return [[{ total: totalOverride ?? catalog.length }], []];
        assert.match(sql, /SELECT resource.id, resource.type/);
        const backwards = sql.includes("ORDER BY resource.createdAt ASC");
        assert.ok(sql.includes(`resource.id ${backwards ? "ASC" : "DESC"}`));
        const hasBoundary =
          sql.includes("resource.createdAt < ?") || sql.includes("resource.createdAt > ?");
        let selected = [...catalog];
        if (hasBoundary) {
          const date = params.at(-3);
          const id = params.at(-1);
          assert.ok(date instanceof Date);
          assert.equal(typeof id, "string");
          if (typeof id !== "string") throw new Error("Expected cursor ID");
          const op = backwards ? ">" : "<";
          assert.ok(
            sql.includes(
              `resource.createdAt ${op} ? OR (resource.createdAt = ? AND resource.id ${op} ?)`,
            ),
          );
          selected = selected.filter((row) =>
            backwards
              ? row.createdAt > date || (row.createdAt.getTime() === date.getTime() && row.id > id)
              : row.createdAt < date || (row.createdAt.getTime() === date.getTime() && row.id < id),
          );
        }
        selected.sort((a, b) => (backwards ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)));
        const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? selected.length);
        return [selected.slice(0, limit), []];
      },
      end: async () => undefined,
    }),
  },
});
mock.module(modulePath("content/instructors.ts"), {
  namedExports: {
    instructorUserIdsForName: async () => {
      resolutions++;
      return ["synthetic-instructor"];
    },
    instructorNamesByContentId: async () => new Map(),
    legacyInstructorNamesForFilter: async () => ["Fixture Instructor"],
  },
});
mock.module(appRequire.resolve("next/cache"), {
  namedExports: { cacheLife: () => undefined, cacheTag: () => undefined },
});

// Exercise the real SDK and both Typesense document adapters against HTTP fixtures.
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  nativeRequests.push(url);
  const page = Number(url.searchParams.get("page") ?? 1);
  const size = Number(url.searchParams.get("per_page"));
  const legacy = url.pathname.includes("content_production");
  const selected = catalog.slice((page - 1) * size, page * size);
  const hits = selected.map((row) => ({
    document: legacy
      ? {
          id: row.id,
          type: "article",
          title: "Fixture",
          slug: row.fields.slug,
          description: "Fixture",
          path: `/lessons/${row.fields.slug}`,
        }
      : {
          id: row.id,
          type: row.type,
          title: "Fixture",
          slug: row.fields.slug,
          description: "Fixture",
          path: `/${row.fields.slug}`,
        },
  }));
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ found: totalOverride ?? catalog.length, hits }));
});
let port = 0;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  port = address.port;
});
after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  mock.restoreAll();
});
beforeEach(() => {
  catalog = rows;
  totalOverride = null;
  resolutions = 0;
  statements.length = 0;
  nativeRequests.length = 0;
  delete process.env["NEXT_PUBLIC_TYPESENSE_HOST_HASH"];
  delete process.env["NEXT_PUBLIC_TYPESENSE_HOST"];
  delete process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"];
});
const { searchContentPage }: { searchContentPage: typeof ReadPage } = await import(
  modulePath("content/search.ts")
);

for (const source of ["sql", "canonical", "legacy"] as const) {
  void test(`${source}: totals, tied ordering, reverse paging, and statement budgets`, async () => {
    if (source !== "sql") {
      process.env["TYPESENSE_COLLECTION_NAME"] =
        source === "legacy" ? "content_production" : "fixture";
      process.env["NEXT_PUBLIC_TYPESENSE_HOST"] = "127.0.0.1";
      process.env["NEXT_PUBLIC_TYPESENSE_PROTOCOL"] = "http";
      process.env["NEXT_PUBLIC_TYPESENSE_PORT"] = String(port);
      process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"] = "synthetic-reader";
    }
    const query = { term: "fixture", contentType: "article", instructor: "Fixture Instructor" };
    const first = await searchContentPage(query);
    assert.equal(first.kind, "page");
    if (first.kind !== "page") throw new Error("Expected page");
    assert.deepEqual(
      first.results.map((x) => x.id),
      rows.slice(0, 24).map((x) => x.id),
    );
    assert.equal(first.pagination.total, 49);
    assert.equal(first.pagination.totalPages, 3);
    assert.equal(first.pagination.previousCursor, null);
    assert.ok(first.pagination.nextCursor);
    if (source === "sql") {
      assert.equal(resolutions, 1, "One instructor resolution shared by count and page");
      assert.equal(statements.length, 2, "Only count and page SQL, independent of page size");
      const count = statements.find((x) => x.sql.includes("COUNT(*)"));
      const page = statements.find((x) => !x.sql.includes("COUNT(*)"));
      assert.ok(count && page);
      assert.deepEqual(count.params, [
        "article",
        "%fixture%",
        "%fixture%",
        "%fixture%",
        "synthetic-instructor",
      ]);
      assert.deepEqual(page.params, count.params);
      assert.equal(
        page.sql.split("WHERE ")[1]?.split("ORDER BY")[0]?.trim(),
        count.sql.split("WHERE ")[1]?.trim(),
      );
    } else {
      assert.equal(statements.length, 0, "Indexed search never reads SQL");
      assert.equal(nativeRequests.length, 1);
      assert.equal(nativeRequests[0]?.searchParams.get("per_page"), "24");
    }
    const second = await searchContentPage(query, first.pagination.nextCursor);
    if (second.kind !== "page") throw new Error("Expected second page");
    assert.deepEqual(
      second.results.map((x) => x.id),
      rows.slice(24, 48).map((x) => x.id),
    );
    assert.ok(second.pagination.nextCursor);
    assert.ok(second.pagination.previousCursor);
    const third = await searchContentPage(query, second.pagination.nextCursor);
    if (third.kind !== "page") throw new Error("Expected last page");
    assert.equal(third.pagination.page, 3);
    assert.equal(third.pagination.nextCursor, null);
    assert.deepEqual(
      third.results.map((x) => x.id),
      ["synthetic-001"],
    );
    assert.ok(third.pagination.previousCursor);
    const reverse = await searchContentPage(query, third.pagination.previousCursor);
    if (reverse.kind !== "page") throw new Error("Expected reverse page");
    assert.deepEqual(reverse.results, second.results);
    // A removed page or conflicting cached count never reaches the presenter as a page.
    catalog = [];
    assert.deepEqual(await searchContentPage(query, second.pagination.nextCursor), {
      kind: "stale-page",
    });
    catalog = rows;
    totalOverride = 24;
    assert.deepEqual(await searchContentPage(query, first.pagination.nextCursor), {
      kind: "stale-page",
    });
    totalOverride = null;
    catalog = rows.slice(0, 24);
    const exact = await searchContentPage(query);
    if (exact.kind !== "page") throw new Error("Expected exact page");
    assert.equal(exact.pagination.totalPages, 1);
    assert.equal(exact.pagination.nextCursor, null);
    catalog = [];
    const empty = await searchContentPage(query);
    if (empty.kind !== "page") throw new Error("Expected empty first page");
    assert.equal(empty.pagination.total, 0);
    assert.equal(empty.pagination.firstIndex, 0);
  });
}

void test("SQL rejects an out-of-range claimed page even when the boundary returns rows", async () => {
  const query = { term: "fixture" };
  const cursor = encodeSearchCursor({
    source: "sql",
    page: 100,
    scope: searchScope("fixture"),
    direction: "next",
    boundary: { id: "synthetic-049", createdAt: "2030-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(await searchContentPage(query, cursor), { kind: "stale-page" });
});
