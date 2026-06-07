import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../src/db/local-docker";

const SYSTEM_MIGRATION_USER_ID = "c903e890-0970-4d13-bdee-ea535aaaf69b";
const GATED_FIXTURE_ID = "eh_lesson_phase1_mve_gated_video";
const GATED_FIXTURE_SLUG = "phase-1-mve-gated-video-fixture";

type LessonFixtureRow = RowDataPacket & {
  id: string;
  fields: Record<string, unknown> | string;
};

function hashValue(kind: string, value: string) {
  return createHash("sha1").update(`${kind}:${value}`).digest("hex").slice(0, 16);
}

function fieldsFromJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return fieldsFromJson(parsed);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }

  return {};
}

async function ensureGatedFixture() {
  const connection = await createLocalMysqlConnection();

  try {
    const [sourceRows] = await connection.execute<LessonFixtureRow[]>(
      `
        SELECT id, fields
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND (
            type = 'lesson'
            OR (
              type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'lesson'
            )
          )
          AND JSON_EXTRACT(fields, '$.freeForever') = true
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.currentVideoHlsUrl')) IS NOT NULL
        ORDER BY id ASC
        LIMIT 1
      `,
    );
    const sourceLesson = sourceRows[0];

    if (!sourceLesson) {
      return {
        ok: false,
        error: "missing_free_video_fixture",
      };
    }

    const sourceFields = fieldsFromJson(sourceLesson.fields);
    const sourceSlug = typeof sourceFields["slug"] === "string" ? sourceFields["slug"] : "";
    const gatedFields = {
      title: "Phase 1 Gated Video Fixture",
      slug: GATED_FIXTURE_SLUG,
      description: "Local-only gated lesson fixture for Phase 1 access checks.",
      summary: "Local-only gated lesson fixture for Phase 1 access checks.",
      postType: "lesson",
      duration: sourceFields["duration"] ?? 60,
      state: "published",
      visibilityState: "indexed",
      publishedAt: "2026-06-07T00:00:00.000Z",
      freeForever: false,
      isProContent: true,
      currentVideoHlsUrl: sourceFields["currentVideoHlsUrl"] ?? null,
      currentVideoDashUrl: null,
      hasTranscript: false,
      hasSrt: false,
      transcriptPolicy: "needs_source",
      migratedFrom: "phase1_mve_local_fixture",
      sourceVideoFixtureHash: hashValue("coursebuilder-resource", sourceLesson.id),
    };

    await connection.execute(
      `
        INSERT INTO egghead_ContentResource
          (id, type, createdById, fields, createdAt, updatedAt, deletedAt)
        VALUES (?, 'post', ?, CAST(? AS JSON), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), NULL)
        ON DUPLICATE KEY UPDATE
          type = VALUES(type),
          createdById = VALUES(createdById),
          fields = VALUES(fields),
          updatedAt = CURRENT_TIMESTAMP(3),
          deletedAt = NULL
      `,
      [GATED_FIXTURE_ID, SYSTEM_MIGRATION_USER_ID, JSON.stringify(gatedFields)],
    );

    return {
      ok: true,
      freeLesson: {
        slug: sourceSlug,
        resourceHash: hashValue("coursebuilder-resource", sourceLesson.id),
        hasVideo: Boolean(sourceFields["currentVideoHlsUrl"]),
        hasTranscriptEvidence:
          sourceFields["hasTranscript"] === true || sourceFields["hasSrt"] === true,
      },
      gatedLesson: {
        slug: GATED_FIXTURE_SLUG,
        resourceHash: hashValue("coursebuilder-resource", GATED_FIXTURE_ID),
        hasVideo: Boolean(gatedFields.currentVideoHlsUrl),
        accessRequired: true,
        transcriptPolicy: gatedFields.transcriptPolicy,
      },
      guardrails: {
        localDevOnly: true,
        requestTimeRailsFallback: false,
        rawRowsInOutput: false,
      },
    };
  } finally {
    await connection.end();
  }
}

const result = await ensureGatedFixture();
const resultOk = result.ok;

console.log(
  JSON.stringify({
    source: "egghead-standalone-experience-fixtures.v1",
    ...result,
    ok: resultOk,
  }),
);

if (!resultOk) process.exitCode = 1;
