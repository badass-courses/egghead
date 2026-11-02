import { checkEggheadTypesenseReader } from "../apps/web/src/content/typesense-reindex";
import { getEggheadTypesenseConfig } from "../apps/web/src/content/typesense";

try {
  const { collectionName, searchSchema } = getEggheadTypesenseConfig();
  if (searchSchema !== "canonical") throw new Error("Canonical collection required.");
  await checkEggheadTypesenseReader(collectionName);
  console.log(JSON.stringify({ ok: true, collectionName }));
} catch {
  console.error(
    "Typesense preflight failed: check reader permissions, schema, and populated instructor facets.",
  );
  process.exitCode = 1;
}
