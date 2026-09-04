import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { assertProgressWritesAllowed } from "../db/local-docker";
import { withProgressTransaction, type ProgressConnection } from "./progress-transaction";

type CompletedLessonCountRow = RowDataPacket & {
  completedCount: number | string;
};

type CourseProgressRow = RowDataPacket & {
  completedAt: Date | null;
  fields: unknown;
};

export type CourseReview = {
  rating: number;
  comment: string;
  submittedAt: string;
};

export type CourseProgressSyncState = {
  completed: boolean;
  completedAt: string | null;
  reviewSubmitted: boolean;
  emptyCourse: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsFromJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function courseReviewFromFields(value: unknown): CourseReview | null {
  const review = fieldsFromJson(value)["review"];
  if (!isRecord(review)) return null;

  const rating = review["rating"];
  const comment = review["comment"];
  const submittedAt = review["submittedAt"];

  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 7 ||
    typeof comment !== "string" ||
    typeof submittedAt !== "string"
  ) {
    return null;
  }

  return { rating, comment, submittedAt };
}

async function readCourseProgressRow(
  connection: ProgressConnection,
  input: { userId: string; courseId: string },
) {
  const [rows] = await connection.execute<CourseProgressRow[]>(
    `
      SELECT completedAt, fields
      FROM egghead_ResourceProgress
      WHERE userId = ?
        AND resourceId = ?
      LIMIT 1
    `,
    [input.userId, input.courseId],
  );

  return rows[0] ?? null;
}

export async function syncCourseProgressForUser(
  input: {
    userId: string;
    courseId: string;
    lessonIds: readonly string[];
  },
  sharedConnection?: ProgressConnection,
): Promise<CourseProgressSyncState> {
  const safety = assertProgressWritesAllowed();
  if (!sharedConnection) {
    return withProgressTransaction(input.userId, (connection) =>
      syncCourseProgressForUser(input, connection),
    );
  }
  const lessonIds = [...new Set(input.lessonIds.filter(Boolean))];
  const connection = sharedConnection;

  let completedCount = 0;

  if (lessonIds.length > 0) {
    const placeholders = lessonIds.map(() => "?").join(", ");
    const [countRows] = await connection.execute<CompletedLessonCountRow[]>(
      `
          SELECT COUNT(DISTINCT resourceId) AS completedCount
          FROM egghead_ResourceProgress
          WHERE userId = ?
            AND completedAt IS NOT NULL
            AND resourceId IN (${placeholders})
          FOR SHARE
        `,
      [input.userId, ...lessonIds],
    );
    completedCount = Number(countRows[0]?.completedCount ?? 0);
  }
  const completed = lessonIds.length > 0 && completedCount === lessonIds.length;
  const progressFields = JSON.stringify({
    source: completed ? "all_lessons_completed" : "course_lessons_incomplete",
    localOnly: safety.localDockerOnly,
  });

  if (completed) {
    await connection.execute<ResultSetHeader>(
      `
          INSERT INTO egghead_ResourceProgress
            (userId, resourceId, completedAt, fields, createdAt, updatedAt)
          VALUES (?, ?, CURRENT_TIMESTAMP(3), CAST(? AS JSON), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE
            completedAt = COALESCE(completedAt, VALUES(completedAt)),
            fields = JSON_MERGE_PATCH(COALESCE(fields, JSON_OBJECT()), VALUES(fields)),
            updatedAt = CURRENT_TIMESTAMP(3)
        `,
      [input.userId, input.courseId, progressFields],
    );
  } else {
    await connection.execute<ResultSetHeader>(
      `
          UPDATE egghead_ResourceProgress
          SET completedAt = NULL,
              fields = JSON_MERGE_PATCH(COALESCE(fields, JSON_OBJECT()), CAST(? AS JSON)),
              updatedAt = CURRENT_TIMESTAMP(3)
          WHERE userId = ?
            AND resourceId = ?
        `,
      [progressFields, input.userId, input.courseId],
    );
  }

  const row = await readCourseProgressRow(connection, input);

  return {
    completed: row?.completedAt !== null && row?.completedAt !== undefined,
    completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
    reviewSubmitted: courseReviewFromFields(row?.fields) !== null,
    emptyCourse: lessonIds.length === 0,
  };
}

export type CourseReviewWriteResult =
  | { status: "saved"; review: CourseReview }
  | { status: "course_incomplete" | "missing_progress"; review: null };

export async function saveCourseReviewForUser(
  input: {
    userId: string;
    courseId: string;
    rating: number;
    comment: string;
  },
  sharedConnection?: ProgressConnection,
): Promise<CourseReviewWriteResult> {
  const safety = assertProgressWritesAllowed();
  if (!sharedConnection) {
    return withProgressTransaction(input.userId, (connection) =>
      saveCourseReviewForUser(input, connection),
    );
  }
  const connection = sharedConnection;
  const review: CourseReview = {
    rating: input.rating,
    comment: input.comment,
    submittedAt: new Date().toISOString(),
  };
  const fields = JSON.stringify({
    source: "course_review_submission",
    localOnly: safety.localDockerOnly,
    review,
  });

  const [result] = await connection.execute<ResultSetHeader>(
    `
        UPDATE egghead_ResourceProgress
        SET fields = JSON_MERGE_PATCH(COALESCE(fields, JSON_OBJECT()), CAST(? AS JSON)),
            updatedAt = CURRENT_TIMESTAMP(3)
        WHERE userId = ?
          AND resourceId = ?
          AND completedAt IS NOT NULL
      `,
    [fields, input.userId, input.courseId],
  );

  if (result.affectedRows > 0) {
    return { status: "saved" as const, review };
  }

  const progress = await readCourseProgressRow(connection, input);
  return progress
    ? { status: "course_incomplete" as const, review: null }
    : { status: "missing_progress" as const, review: null };
}
