import { readFileSync } from "node:fs";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import { expect, it, vi } from "vitest";

function snapshotColumns(sql: string) {
  const tables = new Map<string, Set<string>>();
  for (const match of sql.matchAll(/CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\)[^;]*;/g)) {
    const name = match[1];
    const definition = match[2];
    if (!name || !definition) throw new Error("Invalid schema snapshot");
    tables.set(
      name,
      new Set([...definition.matchAll(/^\s+`([^`]+)`\s/gm)].map((column) => column[1] ?? "")),
    );
  }
  if (tables.size === 0) throw new Error("No CREATE TABLE definitions in schema snapshot");
  return tables;
}

it("all builder and adapter schema columns exist in the committed live-schema snapshot", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_NAME", "egghead");
  try {
    const schema = await import("../../src/db/schema");
    const sql = readFileSync(new URL("../fixtures/live-schema.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/INSERT\s+INTO|REPLACE\s+INTO|AUTO_INCREMENT=\d/i);
    const live = snapshotColumns(sql);
    const missing: string[] = [];
    let checked = 0;
    for (const table of Object.values(schema)) {
      if (!is(table, MySqlTable)) continue;
      checked++;
      const name = getTableName(table);
      const columns = live.get(name);
      for (const column of Object.values(getTableColumns(table))) {
        if (!columns?.has(column.name)) missing.push(`${name}.${column.name}`);
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(missing, `Missing deployed schema columns:\n${missing.join("\n")}`).toEqual([]);
    // Pin the incident columns even if a future adapter accidentally drops them.
    expect(live.get("egghead_DeviceAccessToken")).toEqual(
      new Set([
        "token",
        "userId",
        "createdAt",
        "organizationMembershipId",
        "scope",
        "expiresAt",
        "revokedAt",
      ]),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it("the snapshot parser fails closed and distinguishes missing columns", () => {
  expect(() => snapshotColumns("SELECT 1")).toThrow();
  const parsed = snapshotColumns("CREATE TABLE `sample` (\n  `id` varchar(191)\n);");
  expect(parsed.get("sample")?.has("expiresAt")).toBe(false);
});
