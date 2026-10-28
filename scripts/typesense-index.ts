import { EGGHEAD_TYPESENSE_COLLECTION_NAME } from "../apps/web/src/content/search-document";
import {
  confirmSearchIndexExclusions,
  loadSearchIndexDocuments,
} from "../apps/web/src/content/search";
import {
  rebuildEggheadTypesenseCollection,
  searchSourceDigest,
  verifyEggheadTypesenseCollection,
} from "../apps/web/src/content/typesense-reindex";
import {
  getEggheadTypesenseConfig,
  TypesenseWorkflowError,
} from "../apps/web/src/content/typesense";

function option(name: string) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  if (
    process.argv.includes("--recreate") ||
    process.argv.includes("--create-only") ||
    option("--limit")
  ) {
    throw new TypesenseWorkflowError(
      "Partial and destructive indexing are unsupported. Build a full versioned collection.",
    );
  }

  if (
    process.argv
      .slice(2)
      .some(
        (arg) =>
          !["--dry-run", "--verify-only", "--promote"].includes(arg) &&
          !/^--(collection|source-sha256)=.+$/.test(arg),
      )
  ) {
    throw new TypesenseWorkflowError("Unknown or incomplete indexing option.");
  }

  const dryRun = process.argv.includes("--dry-run");
  const verifyOnly = process.argv.includes("--verify-only");
  const promote = process.argv.includes("--promote");
  if ((dryRun || verifyOnly) && promote)
    throw new TypesenseWorkflowError("Read-only modes cannot promote an alias.");
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:TZ.]/g, "")
    .slice(0, 14);
  const collectionName =
    option("--collection") ?? `${EGGHEAD_TYPESENSE_COLLECTION_NAME}_${timestamp}`;

  if (verifyOnly) {
    const verified = await verifyEggheadTypesenseCollection(
      option("--collection") ?? getEggheadTypesenseConfig().collectionName,
    );
    console.log(
      JSON.stringify({
        ok: true,
        ...verified,
        instructorCounts: undefined,
        instructors: verified.instructorCounts.length,
      }),
    );
  } else {
    console.error(JSON.stringify({ phase: "load-source" }));
    const documents = await loadSearchIndexDocuments();
    const documentTypes = documents.reduce<Record<string, number>>((counts, document) => {
      counts[document.type] = (counts[document.type] ?? 0) + 1;
      return counts;
    }, {});
    if (dryRun) {
      console.log(
        JSON.stringify({
          ok: true,
          mode: "dry-run",
          collectionName,
          documents: documents.length,
          sourceSha256: searchSourceDigest(documents),
          documentsWithInstructors: documents.filter((document) => document.instructorNames.length)
            .length,
          documentTypes,
        }),
      );
    } else {
      const result = await rebuildEggheadTypesenseCollection({
        collectionName,
        documents,
        promote,
        expectedSourceDigest: option("--source-sha256"),
        reloadSource: () => loadSearchIndexDocuments(),
        confirmExclusions: confirmSearchIndexExclusions,
      });
      console.log(JSON.stringify({ ok: true, ...result, documentTypes }));
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof TypesenseWorkflowError) console.error(error.message);
  console.error(
    "Typesense indexing failed. Check source approval, digest, completeness, schema, and permissions. Confirm alias mapping before retrying; no collection is deleted by this command.",
  );
  process.exitCode = 1;
}
