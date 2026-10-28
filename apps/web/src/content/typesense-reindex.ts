import { createHash } from "node:crypto";

import { instructorMatchKey } from "./encoding";
import {
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  type SearchIndexDocument,
  SEARCH_CONTENT_TYPE_VALUES,
} from "./search-document";
import {
  assertEggheadTypesenseWriteApproved,
  createEggheadTypesenseCollection,
  createEggheadTypesenseSearchClient,
  createEggheadTypesenseWriteClient,
  EGGHEAD_TYPESENSE_ALIAS,
  importEggheadTypesenseDocuments,
  typesenseFilterValue,
  TypesenseWorkflowError,
} from "./typesense";

// Hash only the public search projection; never persist source/customer rows.
export function searchSourceDigest(documents: readonly SearchIndexDocument[]) {
  return createHash("sha256")
    .update(JSON.stringify(documents.toSorted((a, b) => a.id.localeCompare(b.id))))
    .digest("hex");
}

export async function checkEggheadTypesenseReader(collectionName: string) {
  const response = await createEggheadTypesenseSearchClient()
    .collections<SearchIndexDocument>(collectionName)
    .documents()
    .search({
      q: "*",
      query_by: "title,description,summary,body,instructorNames",
      facet_by: "instructorNames,instructorKeys",
      max_facet_values: 1_000,
      per_page: 0,
      sort_by: "updated_at_timestamp:desc",
      filter_by: `type:=[${SEARCH_CONTENT_TYPE_VALUES.join(", ")}]`,
    });
  const names = response.facet_counts?.find((entry) => entry.field_name === "instructorNames");
  const keys = response.facet_counts?.find((entry) => entry.field_name === "instructorKeys");
  if (!response.found || !names?.counts.length || !keys?.counts.length) {
    throw new TypesenseWorkflowError(
      "Typesense verification requires content and populated instructor facets.",
    );
  }
  return response;
}

export async function verifyEggheadTypesenseCollection(collectionName: string) {
  const client = createEggheadTypesenseWriteClient();
  const schema = await client.collections(collectionName).retrieve();
  const incompatible = EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.fields.filter((expected) => {
    if (expected.name === "id") return false;
    const actual = schema.fields.find((field) => field.name === expected.name);
    return !actual || actual.type !== expected.type || (expected.facet && !actual.facet);
  });
  if (incompatible.length) {
    throw new TypesenseWorkflowError(
      `Incompatible Typesense schema: ${incompatible.map((field) => field.name).join(", ")}.`,
    );
  }
  // Exercise the reader key as well as the operator's schema access.
  const response = await checkEggheadTypesenseReader(collectionName);
  const facet = response.facet_counts?.find((entry) => entry.field_name === "instructorNames");
  if (!schema.num_documents || !facet?.counts.length) {
    throw new TypesenseWorkflowError(
      "Typesense verification requires content and populated instructor facets.",
    );
  }
  return {
    collectionName: schema.name,
    documents: schema.num_documents,
    found: response.found,
    instructorCounts: facet.counts.map(({ value, count }) => ({ value, count })),
  };
}

export async function currentEggheadTypesenseAlias() {
  try {
    return (await createEggheadTypesenseWriteClient().aliases(EGGHEAD_TYPESENSE_ALIAS).retrieve())
      .collection_name;
  } catch (error) {
    if (error && typeof error === "object" && "httpStatus" in error && error.httpStatus === 404) {
      return null;
    }
    throw error;
  }
}

export async function rebuildEggheadTypesenseCollection({
  collectionName,
  documents,
  promote = false,
  expectedSourceDigest,
  reloadSource,
  confirmExclusions,
}: {
  collectionName: string;
  documents: readonly SearchIndexDocument[];
  promote?: boolean;
  expectedSourceDigest: string | undefined;
  reloadSource?: () => Promise<readonly SearchIndexDocument[]>;
  confirmExclusions?: (ids: readonly string[]) => Promise<readonly string[]>;
}) {
  assertEggheadTypesenseWriteApproved(collectionName);
  const expectedCounts = new Map<string, number>();
  if (
    !documents.length ||
    new Set(documents.map((document) => document.id)).size !== documents.length
  ) {
    throw new TypesenseWorkflowError("A full index requires nonempty documents with unique IDs.");
  }
  if (expectedSourceDigest !== searchSourceDigest(documents)) {
    throw new TypesenseWorkflowError("Source digest does not match the reviewed dry-run manifest.");
  }
  if (promote && (process.env["EGGHEAD_CONTENT_WRITES_PAUSED"] !== "true" || !reloadSource)) {
    throw new TypesenseWorkflowError(
      "Promotion requires paused content writers and a fresh source comparison.",
    );
  }
  for (const document of documents) {
    if (
      document.instructorKeys.join("|") !==
      document.instructorNames.map(instructorMatchKey).join("|")
    ) {
      throw new TypesenseWorkflowError("Instructor keys must match the indexed display names.");
    }
    for (const name of new Set(document.instructorNames)) {
      expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
    }
  }
  if (!expectedCounts.size || expectedCounts.size >= 1_000) {
    throw new TypesenseWorkflowError(
      "Instructor coverage is empty or exceeds the verification facet limit.",
    );
  }
  const previousCollection = await currentEggheadTypesenseAlias();
  // A partial/misdirected database must not replace the current catalog. On
  // initial rollout compare against v1, then against the existing alias target.
  const baseline = previousCollection ?? "egghead_content_migration_v1";
  const exported = await createEggheadTypesenseWriteClient()
    .collections(baseline)
    .documents()
    .export({ include_fields: "id" });
  const sourceIds = new Set(documents.map((document) => document.id));
  const missing: string[] = [];
  for (const line of exported.split("\n").filter((value) => value.trim())) {
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") {
      throw new TypesenseWorkflowError("Invalid completeness baseline; alias unchanged.");
    }
    if (!sourceIds.has(row.id)) missing.push(row.id);
  }
  const excluded = new Set(confirmExclusions ? await confirmExclusions(missing) : []);
  const unexplained = missing.filter((id) => !excluded.has(id)).length;
  if (unexplained)
    throw new TypesenseWorkflowError(
      `Source omits ${unexplained} indexed documents without publication evidence; alias unchanged.`,
    );
  await createEggheadTypesenseCollection(collectionName);
  const batches = Array.from({ length: Math.ceil(documents.length / 100) }, (_, index) =>
    documents.slice(index * 100, (index + 1) * 100),
  );
  await batches.reduce(async (previous, batch, index) => {
    await previous;
    const offset = index * 100;
    const imported = await importEggheadTypesenseDocuments(collectionName, batch);
    if (imported.failed || imported.imported !== batch.length) {
      throw new TypesenseWorkflowError(
        `Typesense import failed at batch offset ${offset}; alias unchanged.`,
      );
    }
    console.error(
      JSON.stringify({
        phase: "import",
        completed: offset + batch.length,
        total: documents.length,
      }),
    );
  }, Promise.resolve());
  const verified = await verifyEggheadTypesenseCollection(collectionName);
  if (verified.documents !== documents.length || verified.found !== documents.length) {
    throw new TypesenseWorkflowError("Typesense document count mismatch; alias unchanged.");
  }
  if (
    verified.instructorCounts.length !== expectedCounts.size ||
    verified.instructorCounts.some(({ value, count }) => expectedCounts.get(value) !== count)
  ) {
    throw new TypesenseWorkflowError("Typesense instructor coverage mismatch; alias unchanged.");
  }
  const example = documents.find((document) => document.instructorKeys.length);
  if (!example) throw new TypesenseWorkflowError("No instructor search example is available.");
  const key = example.instructorKeys[0];
  if (!key) throw new TypesenseWorkflowError("No instructor filter key is available.");
  const filtered = await createEggheadTypesenseSearchClient()
    .collections<SearchIndexDocument>(collectionName)
    .documents()
    .search({
      q: "*",
      query_by: "title,instructorNames",
      filter_by: `instructorKeys:=${typesenseFilterValue(key)}`,
      per_page: 1,
    });
  if (!filtered.found || !filtered.hits?.[0]?.document.path) {
    throw new TypesenseWorkflowError("Typesense instructor filtering failed; alias unchanged.");
  }
  if (promote) {
    if (!reloadSource || searchSourceDigest(await reloadSource()) !== expectedSourceDigest) {
      throw new TypesenseWorkflowError("Source changed during the build; alias unchanged.");
    }
    if ((await currentEggheadTypesenseAlias()) !== previousCollection) {
      throw new TypesenseWorkflowError(
        "Typesense alias changed during the build; refusing to overwrite it.",
      );
    }
    try {
      // Include the PUT in recovery: the server may apply it before a timeout.
      await createEggheadTypesenseWriteClient().aliases().upsert(EGGHEAD_TYPESENSE_ALIAS, {
        collection_name: collectionName,
      });
      const active = await verifyEggheadTypesenseCollection(EGGHEAD_TYPESENSE_ALIAS);
      if (active.collectionName !== collectionName || active.documents !== documents.length) {
        throw new TypesenseWorkflowError("Alias does not resolve to the verified target.");
      }
    } catch {
      let rolledBack = false;
      try {
        const current = await currentEggheadTypesenseAlias();
        if (current === previousCollection) {
          rolledBack = true;
        } else if (current === collectionName) {
          const client = createEggheadTypesenseWriteClient();
          if (previousCollection) {
            await client
              .aliases()
              .upsert(EGGHEAD_TYPESENSE_ALIAS, { collection_name: previousCollection });
          } else {
            await client.aliases(EGGHEAD_TYPESENSE_ALIAS).delete();
          }
          rolledBack = (await currentEggheadTypesenseAlias()) === previousCollection;
        }
      } catch {
        throw new TypesenseWorkflowError(
          "Alias promotion failed and rollback could not be confirmed; operator recovery required.",
        );
      }
      if (!rolledBack)
        throw new TypesenseWorkflowError(
          "Alias rollback could not be confirmed; operator recovery required.",
        );
      throw new TypesenseWorkflowError("Alias promotion failed; previous mapping confirmed.");
    }
  }
  return {
    alias: EGGHEAD_TYPESENSE_ALIAS,
    collectionName,
    previousCollection,
    promoted: promote,
    documents: verified.documents,
    instructors: verified.instructorCounts.length,
    confirmedExclusions: missing.length,
  };
}
