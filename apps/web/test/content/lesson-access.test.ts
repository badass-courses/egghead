import { describe, expect, it } from "vitest";
import mysql, { type RowDataPacket } from "mysql2/promise";

import type { JsonFields } from "../../src/content/fields";
import {
  lessonExplicitlyProFromFields,
  lessonFreeForeverFromFields,
  lessonFreeForeverSql,
  lessonRequiresAccess,
  lessonRequiresAccessSql,
} from "../../src/content/lesson-access";

type Fixture = {
  name: string;
  fields: JsonFields;
  free: boolean;
  pro: boolean;
};

const fixtures: Fixture[] = [
  { name: "unmarked standalone", fields: {}, free: false, pro: false },
  { name: "Rails camel pro", fields: { isProContent: true }, free: false, pro: true },
  { name: "Rails snake pro", fields: { is_pro_content: true }, free: false, pro: true },
  { name: "Rails older pro mirror", fields: { freeAccess: false }, free: false, pro: true },
  { name: "CB pro post", fields: { access: "pro" }, free: false, pro: true },
  { name: "normalized CB pro", fields: { access: " PRO " }, free: false, pro: true },
  { name: "author-free CB post", fields: { access: "free" }, free: true, pro: false },
  { name: "normalized CB free", fields: { access: " FREE " }, free: true, pro: false },
  { name: "Rails camel free", fields: { isProContent: false }, free: true, pro: false },
  { name: "Rails snake free", fields: { is_pro_content: false }, free: true, pro: false },
  { name: "older free mirror", fields: { freeAccess: true }, free: true, pro: false },
  { name: "snake free forever", fields: { free_forever: true }, free: true, pro: false },
  { name: "manifest free forever", fields: { freeForever: true }, free: true, pro: false },
  {
    name: "Rails free wins over older pro mirror",
    fields: { isProContent: false, freeAccess: false, access: "pro" },
    free: true,
    pro: true,
  },
  {
    name: "preserved camel free marking wins until data repair",
    fields: { isProContent: false, is_pro_content: true },
    free: true,
    pro: true,
  },
  {
    name: "Rails pro wins over author-free mirror",
    fields: { is_pro_content: true, access: "free" },
    free: false,
    pro: true,
  },
  {
    name: "older Rails pro wins over author-free mirror",
    fields: { freeAccess: false, access: "free" },
    free: false,
    pro: true,
  },
  {
    name: "inflated manifest free does not defeat Rails pro",
    fields: { isProContent: true, freeForever: true },
    free: false,
    pro: true,
  },
  {
    name: "inflated manifest free does not defeat older pro mirror",
    fields: { freeAccess: false, freeForever: true },
    free: false,
    pro: true,
  },
  {
    name: "explicit older free marking beats CB pro",
    fields: { freeAccess: true, access: "pro" },
    free: true,
    pro: true,
  },
  {
    name: "CB pro beats inflated manifest",
    fields: { access: "pro", freeForever: true },
    free: false,
    pro: true,
  },
  {
    name: "nonboolean mirrors are not signals",
    fields: { isProContent: "true", is_pro_content: 1, freeAccess: "false" },
    free: false,
    pro: false,
  },
  {
    name: "numeric mirrors are not signals",
    fields: { isProContent: 1, is_pro_content: 0, freeAccess: 0 },
    free: false,
    pro: false,
  },
  {
    name: "null fields",
    fields: { isProContent: null, access: null, freeForever: null },
    free: false,
    pro: false,
  },
];

describe("lesson access law", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const freeForever = lessonFreeForeverFromFields(fixture.fields);
      const isProContent = lessonExplicitlyProFromFields(fixture.fields);
      expect(freeForever).toBe(fixture.free);
      expect(isProContent).toBe(fixture.pro);
      for (const courseLinked of [false, true]) {
        expect(lessonRequiresAccess({ courseLinked, freeForever, isProContent })).toBe(
          (courseLinked || fixture.pro) && !fixture.free,
        );
      }
    });
  }
});

// Optional read-only MySQL proof. Uses only a derived JSON row, never a table.
// LESSON_ACCESS_MYSQL_URL must name a disposable loopback test database.
const mysqlUrl = process.env["LESSON_ACCESS_MYSQL_URL"];
it.skipIf(!mysqlUrl)("MySQL twins agree with TypeScript across the fixture matrix", async () => {
  if (!mysqlUrl) throw new Error("LESSON_ACCESS_MYSQL_URL is required");
  const url = new URL(mysqlUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  ) {
    throw new Error("Lesson access SQL proof requires a loopback _test database");
  }
  const connection = await mysql.createConnection(mysqlUrl);
  try {
    await Promise.all(
      fixtures.flatMap((fixture) =>
        [false, true].map(async (courseLinked) => {
          const [rows] = await connection.execute<
            (RowDataPacket & { free: number; required: number })[]
          >(
            `SELECT ${lessonFreeForeverSql("lesson")} AS free,
            ${lessonRequiresAccessSql("lesson", courseLinked ? "TRUE" : "FALSE")} AS required
           FROM (SELECT CAST(? AS JSON) AS fields) lesson`,
            [JSON.stringify(fixture.fields)],
          );
          expect(rows[0], fixture.name).toEqual({
            free: Number(fixture.free),
            required: Number(
              lessonRequiresAccess({
                courseLinked,
                freeForever: lessonFreeForeverFromFields(fixture.fields),
                isProContent: lessonExplicitlyProFromFields(fixture.fields),
              }),
            ),
          });
        }),
      ),
    );
  } finally {
    await connection.end();
  }
});
