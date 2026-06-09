import Typesense from "typesense";

import {
  EGGHEAD_TYPESENSE_COLLECTION_NAME,
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  type SearchIndexDocument,
} from "./search-document";

type TypesenseNode = {
  host: string;
  port: number;
  protocol: string;
};

type TypesenseRuntimeConfig = {
  collectionName: string;
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

  return {
    collectionName:
      env("TYPESENSE_COLLECTION_NAME") ??
      env("NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME") ??
      EGGHEAD_TYPESENSE_COLLECTION_NAME,
    host,
    hostHash: env("NEXT_PUBLIC_TYPESENSE_HOST_HASH") ?? resolveTypesenseHostHash(host),
    port: envNumber("NEXT_PUBLIC_TYPESENSE_PORT", 443),
    protocol: env("NEXT_PUBLIC_TYPESENSE_PROTOCOL") ?? "https",
    searchApiKey: env("NEXT_PUBLIC_TYPESENSE_API_KEY"),
    writeApiKey: env("TYPESENSE_WRITE_API_KEY"),
  };
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

export function assertEggheadTypesenseWriteApproved() {
  const config = getEggheadTypesenseConfig();

  if (process.env["EGGHEAD_TYPESENSE_INDEX_APPROVED"] !== "true") {
    throw new Error("Refusing Typesense writes without EGGHEAD_TYPESENSE_INDEX_APPROVED=true.");
  }

  if (config.collectionName !== EGGHEAD_TYPESENSE_COLLECTION_NAME) {
    throw new Error(
      `Refusing Typesense writes to ${config.collectionName}; expected ${EGGHEAD_TYPESENSE_COLLECTION_NAME}.`,
    );
  }
}

export function eggheadTypesenseCollectionSchema() {
  const config = getEggheadTypesenseConfig();
  return {
    ...EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
    name: config.collectionName,
  };
}

export async function ensureEggheadTypesenseCollection({
  recreate = false,
}: {
  recreate?: boolean;
} = {}) {
  assertEggheadTypesenseWriteApproved();

  const config = getEggheadTypesenseConfig();
  const client = createEggheadTypesenseWriteClient();
  const collection = client.collections(config.collectionName);

  try {
    await collection.retrieve();
    if (!recreate) return { collectionName: config.collectionName, created: false };
    await collection.delete();
  } catch (error) {
    const status =
      error && typeof error === "object" && "httpStatus" in error ? error.httpStatus : null;
    if (status !== 404) throw error;
  }

  await client.collections().create(eggheadTypesenseCollectionSchema());

  return { collectionName: config.collectionName, created: true };
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

export async function importEggheadTypesenseDocuments(documents: readonly SearchIndexDocument[]) {
  assertEggheadTypesenseWriteApproved();

  const config = getEggheadTypesenseConfig();
  const client = createEggheadTypesenseWriteClient();
  const result = await client
    .collections<SearchIndexDocument>(config.collectionName)
    .documents()
    .import([...documents], { action: "upsert", batch_size: 100 });

  return {
    collectionName: config.collectionName,
    documents: documents.length,
    ...parseImportResult(result),
  };
}
