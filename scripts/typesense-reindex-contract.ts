import { deepEqual, equal, rejects } from "node:assert/strict";
import { createServer } from "node:http";

import {
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  searchDocumentFromResource,
} from "../apps/web/src/content/search-document";
import {
  rebuildEggheadTypesenseCollection,
  verifyEggheadTypesenseCollection,
  checkEggheadTypesenseReader,
  searchSourceDigest,
} from "../apps/web/src/content/typesense-reindex";

export async function reindexApiChecks(): Promise<{ name: string; pass: true }[]> {
  const keys = [
    "NEXT_PUBLIC_TYPESENSE_HOST",
    "NEXT_PUBLIC_TYPESENSE_HOST_HASH",
    "NEXT_PUBLIC_TYPESENSE_PORT",
    "NEXT_PUBLIC_TYPESENSE_PROTOCOL",
    "NEXT_PUBLIC_TYPESENSE_API_KEY",
    "TYPESENSE_WRITE_API_KEY",
    "EGGHEAD_TYPESENSE_INDEX_APPROVED",
    "EGGHEAD_CONTENT_WRITES_PAUSED",
  ] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  const document = searchDocumentFromResource({
    instructorNames: ["Fixture Instructor"],
    resource: {
      id: "fixture-lesson",
      type: "lesson",
      createdAt: "2030-01-01",
      updatedAt: "2030-01-01",
      fields: {
        title: "Fixture lesson",
        slug: "fixture-lesson",
        state: "published",
        visibility: "public",
      },
    },
  });
  let fixtureDocuments = [document];
  let importOffset = 0;
  let importRequests = 0;
  const target = "egghead_content_migration_v2";
  let alias: string | null = "egghead_content_migration_v1";
  let mode = "success";
  let creates = 0;
  let switches = 0;
  let deletes = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url ?? "/", "http://localhost");
    const fail = (message: string, status = 400) => {
      response.writeHead(status);
      response.end(JSON.stringify({ message }));
    };
    if (url.pathname === "/collections" && request.method === "POST") {
      creates += 1;
      importOffset = 0;
      if (mode === "existing") return fail("Target already exists", 409);
      response.end(JSON.stringify({ name: target }));
    } else if (url.pathname.endsWith("/documents/export")) {
      equal(url.searchParams.get("include_fields"), "id");
      response.setHeader("content-type", "text/plain");
      response.end(
        JSON.stringify({
          id: ["incomplete-source", "confirmed-exclusion"].includes(mode)
            ? "another-lesson"
            : document.id,
        }) + "\n",
      );
    } else if (url.pathname.endsWith("/documents/import")) {
      // Consume the real SDK's upload rather than mocking its result parser.
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const imported: unknown[] = body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      deepEqual(imported, fixtureDocuments.slice(importOffset, importOffset + imported.length));
      importOffset += imported.length;
      importRequests += 1;
      response.setHeader("content-type", "text/plain");
      response.end(
        imported.map(() => JSON.stringify({ success: mode !== "import-failure" })).join("\n"),
      );
    } else if (url.pathname.endsWith("/documents/search")) {
      if (mode === "target-denied" && !url.pathname.includes("/egghead_content/"))
        return fail("Target denied", 403);
      if (
        ["alias-denied", "rollback-failure"].includes(mode) &&
        url.pathname.includes("/egghead_content/")
      ) {
        return fail("Search key cannot read alias", 403);
      }
      equal(request.headers["x-typesense-api-key"], "fixture-reader");
      response.end(
        JSON.stringify({
          found:
            mode === "count-mismatch"
              ? 2
              : mode === "filter-failure" &&
                  url.searchParams.get("filter_by")?.startsWith("instructorKeys")
                ? 0
                : fixtureDocuments.length,
          hits: [{ document }],
          facet_counts: [
            {
              field_name: "instructorNames",
              counts: [
                {
                  value: "Fixture Instructor",
                  count: mode === "facet-mismatch" ? 2 : fixtureDocuments.length,
                },
              ],
            },
            {
              field_name: "instructorKeys",
              counts:
                mode === "reader-missing-facet"
                  ? []
                  : [{ value: "fixtureinstructor", count: fixtureDocuments.length }],
            },
          ],
        }),
      );
    } else if (url.pathname.startsWith("/collections/")) {
      response.end(
        JSON.stringify({
          ...EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
          name: url.pathname.includes("/egghead_content/") ? alias : target,
          num_documents: fixtureDocuments.length,
          fields: EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.fields.filter(
            (field) => mode !== "missing-schema" || field.name !== "instructorNames",
          ),
        }),
      );
    } else if (url.pathname === "/aliases/egghead_content") {
      if (request.method === "PUT") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const mapping: unknown = JSON.parse(body);
        if (
          !mapping ||
          typeof mapping !== "object" ||
          !("collection_name" in mapping) ||
          typeof mapping.collection_name !== "string"
        ) {
          return fail("Invalid alias mapping");
        }
        if (mode === "alias-write-denied") return fail("Alias write denied", 403);
        if (mode === "rollback-failure" && mapping.collection_name !== target)
          return fail("Rollback denied", 403);
        alias = mapping.collection_name;
        switches += 1;
        if (mode === "applied-error" && alias === target) return fail("Response lost after apply");
      } else if (request.method === "DELETE") {
        deletes += 1;
        alias = null;
        response.end(JSON.stringify({ name: "egghead_content" }));
        return;
      }
      if (alias === null) return fail("Alias not found", 404);
      response.end(JSON.stringify({ name: "egghead_content", collection_name: alias }));
    } else fail("Unexpected fixture request", 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    process.env["NEXT_PUBLIC_TYPESENSE_HOST"] = "127.0.0.1";
    delete process.env["NEXT_PUBLIC_TYPESENSE_HOST_HASH"];
    process.env["NEXT_PUBLIC_TYPESENSE_PORT"] = String(address.port);
    process.env["NEXT_PUBLIC_TYPESENSE_PROTOCOL"] = "http";
    process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"] = "fixture-reader";
    process.env["TYPESENSE_WRITE_API_KEY"] = "fixture-writer";
    process.env["EGGHEAD_TYPESENSE_INDEX_APPROVED"] = "true";
    process.env["EGGHEAD_CONTENT_WRITES_PAUSED"] = "true";
    const build = (promote = true) =>
      rebuildEggheadTypesenseCollection({
        collectionName: target,
        documents: fixtureDocuments,
        promote,
        expectedSourceDigest: searchSourceDigest(fixtureDocuments),
        confirmExclusions: async () => (mode === "confirmed-exclusion" ? ["another-lesson"] : []),
        reloadSource: async () => {
          if (mode === "alias-race") alias = "egghead_content_migration_v3";
          return mode === "source-changed" ? [{ ...document, title: "Changed" }] : fixtureDocuments;
        },
      });
    await build(false);
    equal(switches, 0);
    await build();
    equal(alias, target);
    equal(switches, 1);
    await [
      "import-failure",
      "count-mismatch",
      "facet-mismatch",
      "missing-schema",
      "existing",
      "incomplete-source",
      "source-changed",
      "filter-failure",
      "target-denied",
    ].reduce(async (previousFailure, failure) => {
      await previousFailure;
      mode = failure;
      alias = "egghead_content_migration_v1";
      const beforeSwitches: number = switches;
      await rejects(build);
      equal(switches, beforeSwitches);
      equal(alias, "egghead_content_migration_v1");
    }, Promise.resolve());
    mode = "confirmed-exclusion";
    await build(false);
    mode = "alias-denied";
    await rejects(build, /previous mapping confirmed/);
    equal(alias, "egghead_content_migration_v1");
    equal(deletes, 0);
    await ["applied-error", "alias-write-denied"].reduce(async (previousFailure, failure) => {
      await previousFailure;
      mode = failure;
      await rejects(build, /previous mapping confirmed/);
      equal(alias, "egghead_content_migration_v1");
    }, Promise.resolve());
    mode = "alias-race";
    const beforeRace = switches;
    await rejects(build, /alias changed during/);
    equal(alias, "egghead_content_migration_v3");
    equal(switches, beforeRace);
    alias = null;
    mode = "alias-denied";
    await rejects(build, /previous mapping confirmed/);
    equal(alias, null);
    equal(deletes, 1);
    alias = "egghead_content_migration_v1";
    mode = "rollback-failure";
    await rejects(build, /operator recovery required/);
    equal(alias, target);
    mode = "success";
    process.env["EGGHEAD_CONTENT_WRITES_PAUSED"] = "false";
    const beforePause = creates;
    await rejects(build, /paused content writers/);
    equal(creates, beforePause);
    process.env["EGGHEAD_CONTENT_WRITES_PAUSED"] = "true";
    mode = "missing-schema";
    await rejects(() => verifyEggheadTypesenseCollection(target), /instructorNames/);
    mode = "reader-missing-facet";
    delete process.env["TYPESENSE_WRITE_API_KEY"];
    await rejects(() => checkEggheadTypesenseReader(target), /populated instructor facets/);
    mode = "success";
    await checkEggheadTypesenseReader(target);
    process.env["TYPESENSE_WRITE_API_KEY"] = "fixture-writer";
    fixtureDocuments = [
      document,
      ...Array.from({ length: 200 }, (_, index) => ({
        ...document,
        id: `fixture-lesson-${index}`,
      })),
    ];
    const beforeImports = importRequests;
    await build(false);
    equal(importRequests - beforeImports, 3);
    fixtureDocuments = [document];
    const beforeCreates = creates;
    await rejects(
      () =>
        rebuildEggheadTypesenseCollection({
          collectionName: "content_production",
          documents: [document],
          expectedSourceDigest: undefined,
        }),
      /outside versioned/,
    );
    await rejects(
      () =>
        rebuildEggheadTypesenseCollection({
          collectionName: target,
          documents: [],
          expectedSourceDigest: undefined,
        }),
      /nonempty/,
    );
    await rejects(
      () =>
        rebuildEggheadTypesenseCollection({
          collectionName: target,
          documents: [document, document],
          expectedSourceDigest: undefined,
        }),
      /unique IDs/,
    );
    await rejects(
      () =>
        rebuildEggheadTypesenseCollection({
          collectionName: target,
          documents: [{ ...document, instructorNames: [], instructorKeys: [] }],
          expectedSourceDigest: searchSourceDigest([
            { ...document, instructorNames: [], instructorKeys: [] },
          ]),
        }),
      /coverage is empty/,
    );
    await rejects(
      () =>
        rebuildEggheadTypesenseCollection({
          collectionName: target,
          documents: [document],
          expectedSourceDigest: "wrong",
        }),
      /Source digest/,
    );
    equal(creates, beforeCreates);
    return [
      {
        name: "source omissions changes writer activity and concurrent alias changes block promotion",
        pass: true,
      },
      {
        name: "first-alias failure ambiguous PUT and rollback denial have explicit recovery outcomes",
        pass: true,
      },
      { name: "rebuild stages and verifies before switching the stable alias", pass: true },
      {
        name: "bad imports counts facets schemas and existing targets preserve the alias",
        pass: true,
      },
      { name: "unreadable alias rolls back to the previous collection", pass: true },
      {
        name: "preflight detects schema drift and unsafe incomplete builds are refused",
        pass: true,
      },
    ];
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}
