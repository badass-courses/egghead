import { readFile } from "node:fs/promises";
import { Client } from "pg";

import { z } from "zod";

import {
  assertDatabaseUrlForRuntime,
  createEggheadMysqlConnection,
} from "../apps/web/src/db/local-docker";
import { contentResourceSlugSql } from "../apps/web/src/content/resource-slug";
import {
  planRailsInstructorContributions,
  type MigratedAuthorshipResource,
} from "./rails-instructor-contributions-plan";

class InstructorBackfillError extends Error {}

const legacyAuthor = z.object({ id: z.string(), slug: z.string().nullable(), userId: z.string() });
const identity = z.object({ id: z.string(), railsUserId: z.string(), name: z.string().nullable() });
const resource = z.object({
  id: z.string(),
  family: z.enum(["lesson", "course"]),
  railsId: z.string().nullable(),
  slug: z.string().nullable(),
});
const existingContribution = z.object({
  id: z.string(),
  userId: z.string(),
  contentId: z.string(),
  active: z.number(),
  deletedAt: z.unknown(),
});

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply" && !/^--plan-sha256=[a-f0-9]{64}$/.test(arg)))
    throw new InstructorBackfillError("Unknown option.");
  const apply = args.includes("--apply");
  const safety = assertDatabaseUrlForRuntime();
  if (safety.runtime !== "beta" || !safety.betaDatabaseAllowed)
    throw new InstructorBackfillError("Approved beta database required.");
  if (apply && process.env["EGGHEAD_CONTRIBUTION_BACKFILL_APPROVED"] !== "true")
    throw new InstructorBackfillError("Backfill approval required.");
  const caPath = process.env["EGGHEAD_RAILS_CA_FILE"];
  const connectionString = process.env["EGGHEAD_POSTGRES_DATABASE_URL"];
  if (!connectionString || !caPath)
    throw new InstructorBackfillError("Rails URL and verified CA file required.");
  const rails = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true, ca: await readFile(caPath, "utf8") },
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
    connectionTimeoutMillis: 10000,
  });
  const target = await createEggheadMysqlConnection();
  const started = Date.now();
  try {
    await rails.connect();
    // Rails authorship only: never read the users table, emails, or commerce data.
    const lessons = legacyAuthor
      .array()
      .parse(
        (
          await rails.query(
            'SELECT lesson.id::text, lesson.slug, instructor.user_id::text AS "userId" FROM lessons lesson JOIN instructors instructor ON instructor.id = lesson.instructor_id LIMIT 20001',
          )
        ).rows,
      );
    const courses = legacyAuthor
      .array()
      .parse(
        (
          await rails.query(
            'SELECT playlist.id::text, playlist.slug, playlist.owner_id::text AS "userId" FROM playlists playlist JOIN instructors instructor ON instructor.user_id = playlist.owner_id LIMIT 5001',
          )
        ).rows,
      );
    const railsUserIds = [...new Set([...lessons, ...courses].map((row) => row.userId))];
    if (
      !railsUserIds.length ||
      railsUserIds.length > 1000 ||
      lessons.length > 20000 ||
      courses.length > 5000
    )
      throw new InstructorBackfillError("Source row budget exceeded or empty.");
    // This is a bounded range lookup on legacyRailsUserId_idx, not a user scan.
    const [userRows] = await target.execute(
      `SELECT id, legacyRailsUserId AS railsUserId, name FROM egghead_User WHERE legacyRailsUserId IN (${railsUserIds.map(() => "?").join(",")})`,
      railsUserIds,
    );
    const users = identity.array().parse(userRows);
    const slug = await contentResourceSlugSql(target, "resource");
    const resources: MigratedAuthorshipResource[] = [];
    let cursor = "";
    async function readPage(): Promise<void> {
      const [rows] = await target.execute(
        `SELECT resource.id,
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) AS family,
        ${slug} AS slug,
        CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) = 'course'
          THEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.eggheadPlaylistId')), JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.legacyRailsId')))
          ELSE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.eggheadLessonId')), JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.legacyRailsLessonId')), JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.legacyRailsId'))) END AS railsId
        FROM egghead_ContentResource resource WHERE resource.id > ? AND resource.deletedAt IS NULL
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN ('lesson','course')
        ORDER BY resource.id LIMIT 500`,
        [cursor],
      );
      const page = resource.array().parse(rows);
      resources.push(...page);
      if (resources.length > 20000)
        throw new InstructorBackfillError("Target resource row budget exceeded.");
      const last = page.at(-1);
      if (last && page.length === 500) {
        cursor = last.id;
        await readPage();
      }
    }
    await readPage();
    const plan = planRailsInstructorContributions({ resources, lessons, courses, users });
    const [typeRows] = await target.execute(
      "SELECT id FROM egghead_ContributionType WHERE slug = 'instructor' AND active = 1 AND deletedAt IS NULL",
    );
    const types = z.array(z.object({ id: z.string() })).parse(typeRows);
    const typeId = types[0]?.id ?? "contributiontype_rails_instructor";
    const batches = Array.from({ length: Math.ceil(plan.contributions.length / 100) }, (_, index) =>
      plan.contributions.slice(index * 100, (index + 1) * 100),
    );
    let alreadyPresent = 0;
    let conflicts = 0;
    const pending = await batches.reduce(async (previous, batch) => {
      const accumulated = await previous;
      const [rows] = await target.execute(
        `SELECT id, userId, contentId, active, deletedAt FROM egghead_ContentContribution WHERE contributionTypeId = ? AND contentId IN (${batch.map(() => "?").join(",")})`,
        [typeId, ...batch.map((row) => row.contentId)],
      );
      const existing = existingContribution.array().parse(rows);
      for (const item of batch) {
        const matches = existing.filter((row) => row.contentId === item.contentId);
        if (
          matches.some(
            (row) => row.userId !== item.userId || row.active !== 1 || row.deletedAt !== null,
          )
        )
          conflicts += 1;
        else if (matches.length) alreadyPresent += 1;
        else accumulated.push(item);
      }
      return accumulated;
    }, Promise.resolve<typeof plan.contributions>([]));
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        resources: resources.length,
        mapped: plan.contributions.length,
        pending: pending.length,
        alreadyPresent,
        blocked: plan.blocked,
        conflicts,
        withoutLegacyMatch: plan.withoutLegacyMatch,
        planSha256: plan.digest,
        elapsedMs: Date.now() - started,
      }),
    );
    if (!apply) return;
    if (
      plan.blocked ||
      conflicts ||
      !plan.contributions.length ||
      args.find((arg) => arg.startsWith("--plan-sha256="))?.slice(14) !== plan.digest
    )
      throw new InstructorBackfillError(
        "Backfill plan is blocked or does not match the reviewed digest.",
      );
    if (process.env["EGGHEAD_CONTENT_WRITES_PAUSED"] !== "true")
      throw new InstructorBackfillError("Pause content writers before applying.");
    // Only these two content attribution tables are writable. Existing rows are preserved.
    if (!types.length)
      await target.execute(
        "INSERT INTO egghead_ContributionType (id, slug, name, active) VALUES (?, 'instructor', 'Instructor', 1)",
        [typeId],
      );
    const writeBatches = Array.from({ length: Math.ceil(pending.length / 100) }, (_, index) =>
      pending.slice(index * 100, (index + 1) * 100),
    );
    await writeBatches.reduce(async (previous, batch, index) => {
      await previous;
      await target.execute(
        `INSERT INTO egghead_ContentContribution (id, contentId, userId, contributionTypeId, active) VALUES ${batch.map(() => "(?,?,?,?,1)").join(",")} ON DUPLICATE KEY UPDATE id = id`,
        batch.flatMap((row) => [row.id, row.contentId, row.userId, typeId]),
      );
      console.error(
        JSON.stringify({
          phase: "backfill",
          completed: Math.min((index + 1) * 100, pending.length),
          total: pending.length,
        }),
      );
    }, Promise.resolve());
  } finally {
    await Promise.allSettled([rails.end(), target.end()]);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof InstructorBackfillError) console.error(error.message);
  console.error(
    "Instructor backfill failed. Check the reviewed plan, mappings, approval, write freeze, and database permissions. Existing records were not intentionally modified; rerun a dry run before retrying.",
  );
  process.exitCode = 1;
}
