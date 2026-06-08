import type { RowDataPacket } from "mysql2";
import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";
import { publishedResourceSql } from "./publication";
import { pathForPublicContentFamily, type PublicContentFamily } from "./public-resource";

export type ContentIndexFamily = "course" | "lesson" | PublicContentFamily;

type ContentIndexConfig = {
  title: string;
  eyebrow: string;
  description: string;
  canonicalPath: string;
  itemLabel: string;
  limit: number;
};

type ContentIndexRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
};

type CountRow = RowDataPacket & {
  total: number | string;
};

export type ContentIndexItem = {
  id: string;
  family: ContentIndexFamily;
  title: string;
  slug: string;
  description: string;
  href: string;
};

export type ContentIndex = ContentIndexConfig & {
  family: ContentIndexFamily;
  totalCount: number;
  items: ContentIndexItem[];
};

const CONTENT_INDEX_CONFIG = {
  article: {
    title: "Articles",
    eyebrow: "Articles",
    description: "Field notes, essays, and written tutorials from egghead.",
    canonicalPath: "/blog",
    itemLabel: "Article",
    limit: 96,
  },
  campaign: {
    title: "Campaigns",
    eyebrow: "Campaigns",
    description: "Retained egghead campaign pages and launch archives.",
    canonicalPath: "/campaigns",
    itemLabel: "Campaign",
    limit: 96,
  },
  "case-study": {
    title: "Case Studies",
    eyebrow: "Case studies",
    description: "Stories showing how developers and teams use egghead.",
    canonicalPath: "/case-studies",
    itemLabel: "Case study",
    limit: 96,
  },
  course: {
    title: "Courses",
    eyebrow: "Courses",
    description: "Structured egghead courses and their lessons.",
    canonicalPath: "/courses",
    itemLabel: "Course",
    limit: 96,
  },
  guide: {
    title: "Guides",
    eyebrow: "Guides",
    description: "Practical guides and project-based learning paths.",
    canonicalPath: "/guides",
    itemLabel: "Guide",
    limit: 96,
  },
  lesson: {
    title: "Lessons",
    eyebrow: "Lessons",
    description: "Standalone lessons and lessons linked to egghead courses.",
    canonicalPath: "/lessons",
    itemLabel: "Lesson",
    limit: 120,
  },
  podcast: {
    title: "Podcasts",
    eyebrow: "Podcasts",
    description: "Conversations with working developers and technical leaders.",
    canonicalPath: "/podcasts",
    itemLabel: "Podcast",
    limit: 96,
  },
  project: {
    title: "Projects",
    eyebrow: "Projects",
    description: "Project pages and retained hands-on learning material.",
    canonicalPath: "/projects",
    itemLabel: "Project",
    limit: 96,
  },
  "success-story": {
    title: "Success Stories",
    eyebrow: "Success stories",
    description: "Learner outcomes and customer stories from egghead.",
    canonicalPath: "/success-stories",
    itemLabel: "Success story",
    limit: 96,
  },
  talk: {
    title: "Talks",
    eyebrow: "Talks",
    description: "Conference talks and presentations from the egghead archive.",
    canonicalPath: "/talks",
    itemLabel: "Talk",
    limit: 96,
  },
  tip: {
    title: "Tips",
    eyebrow: "Tips",
    description: "Short, focused development tips from egghead.",
    canonicalPath: "/tips",
    itemLabel: "Tip",
    limit: 96,
  },
} satisfies Record<ContentIndexFamily, ContentIndexConfig>;

function resourceWhereClause(family: ContentIndexFamily, alias = "resource") {
  if (family === "course") {
    return {
      sql: `
        AND (
          ${alias}.type = 'course'
          OR (
            ${alias}.type = 'post'
            AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')) = 'course'
          )
        )
      `,
      params: [],
    };
  }

  if (family === "lesson") {
    return {
      sql: `
        AND (
          ${alias}.type = 'lesson'
          OR (
            ${alias}.type = 'post'
            AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')) = 'lesson'
          )
        )
      `,
      params: [],
    };
  }

  return {
    sql: `AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')), ${alias}.type) = ?`,
    params: [family],
  };
}

function hrefForContentIndexItem(family: ContentIndexFamily, slug: string) {
  if (family === "course") return `/courses/${slug}`;
  if (family === "lesson") return `/lessons/${slug}`;
  return pathForPublicContentFamily(family, slug);
}

function toContentIndexItem(
  row: ContentIndexRow,
  family: ContentIndexFamily,
): ContentIndexItem | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");

  if (!slug) return null;

  return {
    id: row.id,
    family,
    title: stringField(fields, "title") ?? "Untitled",
    slug,
    description: descriptionField(fields),
    href: hrefForContentIndexItem(family, slug),
  };
}

export function contentIndexMetadata(family: ContentIndexFamily): Metadata {
  const config = CONTENT_INDEX_CONFIG[family];

  return {
    title: `${config.title} | egghead`,
    description: config.description,
    alternates: {
      canonical: `https://egghead.io${config.canonicalPath}`,
    },
    openGraph: {
      title: config.title,
      description: config.description,
      url: `https://egghead.io${config.canonicalPath}`,
      type: "website",
    },
  };
}

export async function getContentIndex(family: ContentIndexFamily): Promise<ContentIndex> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-content-index:${family}`);

  const config = CONTENT_INDEX_CONFIG[family];
  const where = resourceWhereClause(family, "resource");
  const connection = await createLocalMysqlConnection();

  try {
    const [countRows] = await connection.execute<CountRow[]>(
      `
        SELECT COUNT(*) AS total
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) != ''
          ${where.sql}
      `,
      where.params,
    );
    const [rows] = await connection.execute<ContentIndexRow[]>(
      `
        SELECT resource.id, resource.type, resource.fields
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) != ''
          ${where.sql}
        ORDER BY resource.createdAt DESC
        LIMIT ?
      `,
      [...where.params, config.limit],
    );

    return {
      ...config,
      family,
      totalCount: Number(countRows[0]?.total ?? 0),
      items: rows
        .map((row) => toContentIndexItem(row, family))
        .filter((item): item is ContentIndexItem => item !== null),
    };
  } finally {
    await connection.end();
  }
}
