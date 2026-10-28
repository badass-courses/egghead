import Typesense from "typesense";

import {
  EGGHEAD_TYPESENSE_COLLECTION_NAME,
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  LEGACY_SEARCH_DOCUMENT_TYPES,
  type SearchIndexDocument,
} from "./search-document";

type TypesenseNode = {
  host: string;
  port: number;
  protocol: string;
};

type TypesenseRuntimeConfig = {
  collectionName: string;
  searchSchema: "canonical" | "legacy";
  host: string | null;
  hostHash: string | null;
  port: number;
  protocol: string;
  searchApiKey: string | null;
  writeApiKey: string | null;
};

type TypesenseImportLine = {
  success?: boolean;
  error?: string;
};

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envNumber(name: string, fallback: number) {
  const value = env(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveTypesenseHostHash(host: string | null | undefined) {
  if (!host) return null;
  const match = host.match(/^(.*)-\d+\.a1\.typesense\.net$/);
  return match?.[1] ?? null;
}

export function getEggheadTypesenseConfig(): TypesenseRuntimeConfig {
  const host = env("NEXT_PUBLIC_TYPESENSE_HOST");
  const collectionName =
    env("TYPESENSE_COLLECTION_NAME") ??
    env("NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME") ??
    EGGHEAD_TYPESENSE_COLLECTION_NAME;

  return {
    collectionName,
    // Only this supplied collection uses the Rails-era read contract.
    searchSchema: collectionName === "content_production" ? "legacy" : "canonical",
    host,
    hostHash: env("NEXT_PUBLIC_TYPESENSE_HOST_HASH") ?? resolveTypesenseHostHash(host),
    port: envNumber("NEXT_PUBLIC_TYPESENSE_PORT", 443),
    protocol: env("NEXT_PUBLIC_TYPESENSE_PROTOCOL") ?? "https",
    searchApiKey: env("NEXT_PUBLIC_TYPESENSE_API_KEY"),
    writeApiKey: env("TYPESENSE_WRITE_API_KEY"),
  };
}

export function legacyTypesenseContentFilter(typeFilter?: string | null) {
  const type = typeFilter?.trim();
  const legacyType = type === "course" ? "playlist" : type;
  // content_production is publisher-scoped: it has no state/visibility fields.
  // Publication timestamps are absent on some published courses, so they
  // cannot be used as a lifecycle filter. Facets and hits share this scope.
  return legacyType
    ? LEGACY_SEARCH_DOCUMENT_TYPES.some((value) => value === legacyType)
      ? `type:=${legacyType}`
      : "type:=__invalid__"
    : `type:=[${LEGACY_SEARCH_DOCUMENT_TYPES.join(", ")}]`;
}

export function getEggheadTypesenseNodes(
  config: Pick<TypesenseRuntimeConfig, "host" | "hostHash" | "port" | "protocol">,
) {
  const nodes: TypesenseNode[] = [];

  if (config.host) {
    nodes.push({
      host: config.host,
      port: config.port,
      protocol: config.protocol,
    });
  }

  if (config.hostHash) {
    for (const index of [1, 2, 3]) {
      const host = `${config.hostHash}-${index}.a1.typesense.net`;
      if (nodes.some((node) => node.host === host)) continue;
      nodes.push({
        host,
        port: config.port,
        protocol: config.protocol,
      });
    }
  }

  return nodes;
}

function createClient(apiKey: string) {
  const config = getEggheadTypesenseConfig();
  const nodes = getEggheadTypesenseNodes(config);

  if (!config.host || nodes.length === 0) {
    throw new Error("Typesense host is not configured.");
  }

  return new Typesense.Client({
    nearestNode: {
      host: config.host,
      port: config.port,
      protocol: config.protocol,
    },
    nodes,
    apiKey,
    connectionTimeoutSeconds: 3,
  });
}

export function isEggheadTypesenseSearchConfigured() {
  const config = getEggheadTypesenseConfig();
  return Boolean(config.host && config.searchApiKey);
}

export function isEggheadTypesenseWriteConfigured() {
  const config = getEggheadTypesenseConfig();
  return Boolean(config.host && config.writeApiKey);
}

export function createEggheadTypesenseSearchClient() {
  const config = getEggheadTypesenseConfig();
  if (!config.searchApiKey) {
    throw new Error("Typesense search API key is not configured.");
  }

  return createClient(config.searchApiKey);
}

export function createEggheadTypesenseWriteClient() {
  const config = getEggheadTypesenseConfig();
  if (!config.writeApiKey) {
    throw new Error("Typesense write API key is not configured.");
  }

  return createClient(config.writeApiKey);
}

export class TypesenseWorkflowError extends Error {}

export const EGGHEAD_TYPESENSE_ALIAS = "egghead_content";

export function assertEggheadTypesenseWriteApproved(collectionName: string) {
  if (process.env["EGGHEAD_TYPESENSE_INDEX_APPROVED"] !== "true") {
    throw new TypesenseWorkflowError(
      "Refusing Typesense writes without EGGHEAD_TYPESENSE_INDEX_APPROVED=true.",
    );
  }
  if (!/^egghead_content_migration_v[1-9]\d*(?:_\d{14})?$/.test(collectionName)) {
    throw new TypesenseWorkflowError(
      `Refusing Typesense writes outside versioned migration collections: ${collectionName}.`,
    );
  }
}

export function eggheadTypesenseCollectionSchema(collectionName: string) {
  return { ...EGGHEAD_TYPESENSE_COLLECTION_SCHEMA, name: collectionName };
}

export async function createEggheadTypesenseCollection(collectionName: string) {
  assertEggheadTypesenseWriteApproved(collectionName);
  // Never delete or reuse a collection: an existing target is a failed build.
  await createEggheadTypesenseWriteClient()
    .collections()
    .create(eggheadTypesenseCollectionSchema(collectionName));
}

function importLineFromJson(line: string): TypesenseImportLine {
  const parsed: unknown = JSON.parse(line);
  return importLineFromUnknown(parsed);
}

function importLineFromUnknown(parsed: unknown): TypesenseImportLine {
  if (!parsed || typeof parsed !== "object") return {};

  const success =
    "success" in parsed && typeof parsed.success === "boolean" ? parsed.success : undefined;
  const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : undefined;

  return {
    ...(typeof success === "boolean" ? { success } : {}),
    ...(error ? { error } : {}),
  };
}

function summarizeImportLines(lines: TypesenseImportLine[]) {
  return {
    imported: lines.filter((line) => line.success === true).length,
    failed: lines.filter((line) => line.success !== true).length,
    errors: lines
      .filter((line) => line.success !== true && line.error)
      .slice(0, 5)
      .map((line) => line.error ?? "unknown Typesense import error"),
  };
}

function parseImportResult(result: unknown) {
  if (Array.isArray(result)) {
    return summarizeImportLines(result.map(importLineFromUnknown));
  }

  if (typeof result !== "string") {
    return { imported: 0, failed: 0, errors: [] as string[] };
  }

  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(importLineFromJson);

  return summarizeImportLines(lines);
}

export async function importEggheadTypesenseDocuments(
  collectionName: string,
  documents: readonly SearchIndexDocument[],
) {
  assertEggheadTypesenseWriteApproved(collectionName);
  const client = createEggheadTypesenseWriteClient();
  const result = await client
    .collections<SearchIndexDocument>(collectionName)
    .documents()
    .import([...documents], { action: "upsert", batch_size: 100, throwOnFail: false });

  return {
    collectionName,
    documents: documents.length,
    ...parseImportResult(result),
  };
}

export function typesenseFilterValue(value: string) {
  return `\`${value.replaceAll("`", "\\`")}\``;
}
