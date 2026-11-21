import { readFileSync } from "node:fs";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import { getCourseBuilderSchema } from "@coursebuilder/adapter-drizzle/mysql";
import { expect, it, vi } from "vitest";

function snapshotColumns(sql: string) {
  const tables = new Map<string, Set<string>>();
  for (const match of sql.matchAll(/CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\)[^;]*;/g)) {
    const name = match[1];
    const definition = match[2];
    if (!name || !definition) throw new Error("Invalid schema snapshot");
    if (name.startsWith("_vt_")) continue;
    tables.set(
      name,
      new Set([...definition.matchAll(/^\s+`([^`]+)`\s/gm)].map((column) => column[1] ?? "")),
    );
  }
  if (tables.size === 0) throw new Error("No CREATE TABLE definitions in schema snapshot");
  return tables;
}

it("all builder, web and adapter schema columns exist in the committed live-schema snapshot", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_NAME", "egghead");
  try {
    const schema = await import("../../src/db/schema");
    const web = await import("../../../web/src/db/schema");
    const { mysqlTable } = await import("../../src/db/mysql-table");
    const adapter = getCourseBuilderSchema(mysqlTable);
    const sql = readFileSync(new URL("../fixtures/live-schema.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/INSERT\s+INTO|REPLACE\s+INTO|AUTO_INCREMENT=\d/i);
    const live = snapshotColumns(sql);
    const missing = new Set<string>();
    let checked = 0;
    for (const table of [
      ...Object.values(schema),
      ...Object.values(web),
      ...Object.values(adapter),
    ]) {
      if (!is(table, MySqlTable)) continue;
      const name = getTableName(table);
      if (name.startsWith("_vt_")) continue;
      checked++;
      const columns = live.get(name);
      for (const column of Object.values(getTableColumns(table))) {
        if (!columns?.has(column.name)) missing.add(`${name}.${column.name}`);
      }
    }
    expect(checked).toBeGreaterThan(30);
    const gaps = [...missing].toSorted();
    expect(gaps, `Missing deployed schema columns:\n${gaps.join("\n")}`).toEqual([]);
    // Pin the incident columns even if a future adapter accidentally drops them.
    for (const column of [
      "token",
      "userId",
      "createdAt",
      "organizationMembershipId",
      "scope",
      "expiresAt",
      "revokedAt",
    ]) {
      expect(live.get("egghead_DeviceAccessToken")?.has(column)).toBe(true);
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("the snapshot parser fails closed and distinguishes missing columns", () => {
  expect(() => snapshotColumns("SELECT 1")).toThrow();
  const parsed = snapshotColumns("CREATE TABLE `sample` (\n  `id` varchar(191)\n);");
  expect(parsed.get("sample")?.has("expiresAt")).toBe(false);
  const withInternal = snapshotColumns(
    "CREATE TABLE `_vt_internal` (\n  `id` int\n);\nCREATE TABLE `sample` (\n  `id` int\n);",
  );
  expect([...withInternal.keys()]).toEqual(["sample"]);
});
