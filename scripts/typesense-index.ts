import {
  EGGHEAD_TYPESENSE_COLLECTION_NAME,
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
} from "../apps/web/src/content/search-document";
import { loadSearchIndexDocuments } from "../apps/web/src/content/search";
import {
  ensureEggheadTypesenseCollection,
  getEggheadTypesenseConfig,
  importEggheadTypesenseDocuments,
  isEggheadTypesenseWriteConfigured,
} from "../apps/web/src/content/typesense";

function flag(name: string) {
  return process.argv.includes(name);
}

function optionNumber(name: string) {
  const value = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const dryRun = flag("--dry-run");
const recreate = flag("--recreate");
const createOnly = flag("--create-only");
const limit = optionNumber("--limit");
const config = getEggheadTypesenseConfig();

if (!dryRun && config.collectionName !== EGGHEAD_TYPESENSE_COLLECTION_NAME) {
  throw new Error(
    `Refusing to index ${config.collectionName}; expected ${EGGHEAD_TYPESENSE_COLLECTION_NAME}.`,
  );
}

const documents = createOnly
  ? []
  : await loadSearchIndexDocuments(typeof limit === "number" ? { limit } : {});
const documentTypes = documents.reduce<Record<string, number>>((counts, document) => {
  counts[document.type] = (counts[document.type] ?? 0) + 1;
  return counts;
}, {});

if (dryRun) {
  console.log(
    JSON.stringify({
      ok: true,
      mode: "dry-run",
      collectionName: config.collectionName,
      writeConfigured: isEggheadTypesenseWriteConfigured(),
      schemaName: EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.name,
      documents: documents.length,
      documentTypes,
      samplePaths: documents.slice(0, 8).map((document) => document.path),
    }),
  );
} else {
  const collection = await ensureEggheadTypesenseCollection({ recreate });
  const imported = createOnly ? null : await importEggheadTypesenseDocuments(documents);

  console.log(
    JSON.stringify({
      ok: true,
      mode: createOnly ? "create-only" : "index",
      collection,
      imported,
      documentTypes,
    }),
  );
}
