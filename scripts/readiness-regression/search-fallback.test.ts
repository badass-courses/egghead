import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

import type {
  searchContent as SearchContent,
  SearchResult,
} from "../../apps/web/src/content/search";
import type { ContentResourceForSearch } from "../../apps/web/src/content/search-document";
import { appImport, appModule, resetRuntimeEnvironment } from "./fixtures";

const typesenseEnvironment: Record<string, string | undefined> = {
  TYPESENSE_COLLECTION_NAME: "egghead_content_migration_v1",
  NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME: undefined,
  NEXT_PUBLIC_TYPESENSE_HOST: "search-regression.invalid",
  NEXT_PUBLIC_TYPESENSE_HOST_HASH: undefined,
  NEXT_PUBLIC_TYPESENSE_PORT: "443",
  NEXT_PUBLIC_TYPESENSE_PROTOCOL: "https",
  NEXT_PUBLIC_TYPESENSE_API_KEY: "synthetic-search-only-key",
  TYPESENSE_WRITE_API_KEY: undefined,
};
const previousEnvironment = Object.keys(typesenseEnvironment).map(
  (key) => [key, process.env[key]] as const,
);

const sqlRows = [
  {
    id: "search-fallback-post",
    type: "post",
    createdAt: new Date("2030-01-02T00:00:00.000Z"),
    updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    fields: JSON.stringify({
      title: "SQL fallback fixture",
      slug: "search-fallback-post",
      description: "A synthetic result from the SQL catalog.",
      state: "published",
      visibility: "public",
    }),
  },
] satisfies ContentResourceForSearch[];
const sqlResults = [
  {
    id: "search-fallback-post",
    type: "post",
    title: "SQL fallback fixture",
    slug: "search-fallback-post",
    description: "A synthetic result from the SQL catalog.",
    href: "/search-fallback-post",
  },
] satisfies SearchResult[];

// Only I/O is replaced: configuration, SQL readers, and document projection stay real.
const executeFixture = mock.fn(async (sql: string) => {
  if (sql.includes("FROM egghead_ContentResource resource")) return [sqlRows, []];
  if (sql.includes("FROM egghead_ContentContribution contribution")) return [[], []];
  throw new Error(`Unexpected search SQL fixture request: ${sql}`);
});
const queryFixture = mock.fn(async (sql: string) => {
  if (sql === "SHOW COLUMNS FROM egghead_ContentResource LIKE 'slug'") {
    return [[{ Field: "slug" }], []];
  }
  throw new Error(`Unexpected search SQL fixture query: ${sql}`);
});
const endConnection = mock.fn(async () => undefined);
const createConnection = mock.fn(async () => ({
  execute: executeFixture,
  query: queryFixture,
  end: endConnection,
}));
mock.module(appModule("db/local-docker.ts"), {
  namedExports: { createLocalMysqlConnection: createConnection },
});

const typesenseFailure = new Error("Synthetic Typesense search failure");
const searchTypesense = mock.fn(async () => {
  throw typesenseFailure;
});
const selectCollection = mock.fn((_collectionName: string) => ({
  documents: () => ({ search: searchTypesense }),
}));
class TypesenseClientFixture {
  collections = selectCollection;
}
mock.module(appImport("typesense"), {
  defaultExport: { Client: TypesenseClientFixture },
});
const noOp = () => undefined;
mock.module(appImport("next/cache"), {
  namedExports: { cacheLife: noOp, cacheTag: noOp },
});

// Load after installing module mocks; a static import would bind real I/O.
const { searchContent }: { searchContent: typeof SearchContent } = await import(
  appModule("content/search.ts")
);

beforeEach(() => {
  resetRuntimeEnvironment(typesenseEnvironment);
  executeFixture.mock.resetCalls();
  queryFixture.mock.resetCalls();
  endConnection.mock.resetCalls();
  createConnection.mock.resetCalls();
  searchTypesense.mock.resetCalls();
  selectCollection.mock.resetCalls();
});

after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restoreAll();
});

void test("legacy Typesense search failure rejects the original error without consulting SQL", async () => {
  process.env["TYPESENSE_COLLECTION_NAME"] = "content_production";

  await assert.rejects(searchContent("fallback"), (error: unknown) => error === typesenseFailure);

  assert.equal(searchTypesense.mock.callCount(), 1);
  assert.equal(createConnection.mock.callCount(), 0);
  assert.equal(executeFixture.mock.callCount(), 0);
  assert.equal(queryFixture.mock.callCount(), 0);
});

void test("canonical Typesense search failure falls back to SQL query results", async () => {
  assert.deepEqual(await searchContent("fallback"), sqlResults);

  assert.equal(searchTypesense.mock.callCount(), 1);
  assert.ok(createConnection.mock.callCount() > 0);
  assert.equal(endConnection.mock.callCount(), createConnection.mock.callCount());
});

void test("unconfigured Typesense search uses SQL without invoking the provider", async () => {
  delete process.env["NEXT_PUBLIC_TYPESENSE_HOST"];
  delete process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"];

  assert.deepEqual(await searchContent("fallback"), sqlResults);

  assert.equal(selectCollection.mock.callCount(), 0);
  assert.equal(searchTypesense.mock.callCount(), 0);
  assert.ok(createConnection.mock.callCount() > 0);
  assert.equal(endConnection.mock.callCount(), createConnection.mock.callCount());
});

void test("server canonical collection keeps SQL fallback despite a conflicting public legacy collection", async () => {
  process.env["NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME"] = "content_production";

  assert.deepEqual(await searchContent("fallback"), sqlResults);

  assert.equal(searchTypesense.mock.callCount(), 1);
  assert.ok(createConnection.mock.callCount() > 0);
  assert.equal(endConnection.mock.callCount(), createConnection.mock.callCount());
});
