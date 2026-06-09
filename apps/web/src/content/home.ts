import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";
import { publishedResourceSql } from "./publication";
import { collectionPath } from "./routes";
import { pathForPublicContentFamily, type PublicContentFamily } from "./public-resource";

const PUBLIC_CONTENT_FAMILIES = [
  "article",
  "campaign",
  "case-study",
  "guide",
  "podcast",
  "project",
  "success-story",
  "talk",
  "tip",
] satisfies PublicContentFamily[];

type HomeResourceRow = RowDataPacket & {
  id: string;
  family: string | null;
  fields: unknown;
};

export type HomeContentItem = {
  id: string;
  family: "course" | PublicContentFamily;
  title: string;
  slug: string;
  description: string;
  href: string;
};

export type HomeContent = {
  courses: HomeContentItem[];
  resources: HomeContentItem[];
};

function isPublicContentFamily(value: string | null): value is PublicContentFamily {
  return PUBLIC_CONTENT_FAMILIES.some((family) => family === value);
}

function toCourseItem(row: HomeResourceRow): HomeContentItem | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");
  if (!slug) return null;

  return {
    id: row.id,
    family: "course",
    title: stringField(fields, "title") ?? "Untitled course",
    slug,
    description: descriptionField(fields),
    href: collectionPath(slug),
  };
}

function toPublicItem(row: HomeResourceRow): HomeContentItem | null {
  const fields = fieldsFromJson(row.fields);
  const family = isPublicContentFamily(row.family) ? row.family : null;
  const slug = stringField(fields, "slug");
  if (!family || !slug) return null;

  return {
    id: row.id,
    family,
    title: stringField(fields, "title") ?? "Untitled",
    slug,
    description: descriptionField(fields),
    href: stringField(fields, "path") ?? pathForPublicContentFamily(family, slug),
  };
}

export async function getHomeContent(): Promise<HomeContent> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-home");
  cacheTag("egghead-content");

  const connection = await createLocalMysqlConnection();
  const publicFamilyPlaceholders = PUBLIC_CONTENT_FAMILIES.map(() => "?").join(", ");

  try {
    const [courseRows] = await connection.execute<HomeResourceRow[]>(
      `
        SELECT
          course.id,
          'course' AS family,
          course.fields
        FROM egghead_ContentResource course
        WHERE course.deletedAt IS NULL
          ${publishedResourceSql("course")}
          AND JSON_UNQUOTE(JSON_EXTRACT(course.fields, '$.slug')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(course.fields, '$.slug')) != ''
          AND (
            course.type = 'course'
            OR (
              course.type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(course.fields, '$.postType')) = 'course'
            )
          )
        ORDER BY course.createdAt DESC
        LIMIT 6
      `,
    );

    const [resourceRows] = await connection.execute<HomeResourceRow[]>(
      `
        SELECT
          resource.id,
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) AS family,
          resource.fields
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) != ''
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${publicFamilyPlaceholders})
        ORDER BY resource.createdAt DESC
        LIMIT 10
      `,
      [...PUBLIC_CONTENT_FAMILIES],
    );

    return {
      courses: courseRows
        .map(toCourseItem)
        .filter((item): item is HomeContentItem => item !== null),
      resources: resourceRows
        .map(toPublicItem)
        .filter((item): item is HomeContentItem => item !== null),
    };
  } finally {
    await connection.end();
  }
}
