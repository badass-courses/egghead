import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import {
  descriptionField,
  fieldsFromJson,
  markdownField,
  numberField,
  stringField,
} from "./fields";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import { canonicalPodcastPath, legacyPublicContentPath } from "./routes";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type LinkedPodcastEpisodeRow = ContentResourceRow & {
  position: number;
};

type PodcastEpisodeLookupRow = ContentResourceRow & {
  podcastShowId: string | null;
  podcastShowFields: unknown;
};

type PodcastStaticParamRow = RowDataPacket & {
  collection: string;
  entry: string;
};

export type PodcastEpisode = {
  id: string;
  title: string;
  slug: string;
  description: string;
  body: string | null;
  position: number;
  duration: number | null;
  canonicalPath: string;
  legacyPath: string;
  mediaUrl: string | null;
  audioUrl: string | null;
  videoHlsUrl: string | null;
  videoDashUrl: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  podcastShowId: string | null;
  podcastShowSlug: string | null;
  podcastShowTitle: string | null;
};

export type PodcastShowForPage = {
  id: string;
  title: string;
  slug: string;
  description: string;
  body: string | null;
  canonicalPath: string;
  episodeCount: number;
  episodes: PodcastEpisode[];
};

function podcastResourceCondition(alias: string) {
  return `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')), ${alias}.type) = 'podcast'`;
}

function contentResourceKindSql(alias: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.contentResourceKind'))`;
}

function toPodcastEpisode(
  row: LinkedPodcastEpisodeRow,
  show: Pick<PodcastShowForPage, "id" | "slug" | "title">,
): PodcastEpisode | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");

  if (!slug) return null;

  return {
    id: row.id,
    title: stringField(fields, "title") ?? "Untitled episode",
    slug,
    description: descriptionField(fields),
    body: markdownField(fields),
    position: row.position,
    duration: numberField(fields, "duration"),
    canonicalPath: canonicalPodcastPath(slug, show.slug, "podcast-episode"),
    legacyPath: legacyPublicContentPath("podcast", slug),
    mediaUrl: stringField(fields, "mediaUrl"),
    audioUrl: stringField(fields, "audioUrl"),
    videoHlsUrl: stringField(fields, "currentVideoHlsUrl") ?? stringField(fields, "hlsUrl"),
    videoDashUrl: stringField(fields, "currentVideoDashUrl"),
    imageUrl:
      stringField(fields, "imageUrl") ??
      stringField(fields, "image") ??
      stringField(fields, "ogImage") ??
      stringField(fields, "thumbnailUrl"),
    thumbnailUrl: stringField(fields, "thumbnailUrl") ?? stringField(fields, "thumbUrl"),
    podcastShowId: show.id,
    podcastShowSlug: show.slug,
    podcastShowTitle: show.title,
  };
}

function podcastEpisodeFromLookup(
  row: PodcastEpisodeLookupRow,
  fallbackSlug: string,
): PodcastEpisode | null {
  const fields = fieldsFromJson(row.fields);
  const showFields = fieldsFromJson(row.podcastShowFields);
  const slug = stringField(fields, "slug") ?? fallbackSlug;
  const showSlug = stringField(showFields, "slug") ?? stringField(fields, "podcastShowSlug");
  const showTitle = stringField(showFields, "title") ?? stringField(fields, "podcastShowTitle");

  if (!slug) return null;

  return {
    id: row.id,
    title: stringField(fields, "title") ?? "Untitled episode",
    slug,
    description: descriptionField(fields),
    body: markdownField(fields),
    position: 0,
    duration: numberField(fields, "duration"),
    canonicalPath: canonicalPodcastPath(slug, showSlug, "podcast-episode"),
    legacyPath: legacyPublicContentPath("podcast", slug),
    mediaUrl: stringField(fields, "mediaUrl"),
    audioUrl: stringField(fields, "audioUrl"),
    videoHlsUrl: stringField(fields, "currentVideoHlsUrl") ?? stringField(fields, "hlsUrl"),
    videoDashUrl: stringField(fields, "currentVideoDashUrl"),
    imageUrl:
      stringField(fields, "imageUrl") ??
      stringField(fields, "image") ??
      stringField(fields, "ogImage") ??
      stringField(fields, "thumbnailUrl"),
    thumbnailUrl: stringField(fields, "thumbnailUrl") ?? stringField(fields, "thumbUrl"),
    podcastShowId: row.podcastShowId,
    podcastShowSlug: showSlug,
    podcastShowTitle: showTitle,
  };
}

export async function getPodcastShowBySlug(slug: string): Promise<PodcastShowForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-podcast-show:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const showSlugSql = await contentResourceSlugSql(connection, "podcastShow");
    const [showRows] = await connection.execute<ContentResourceRow[]>(
      `
        SELECT podcastShow.id, podcastShow.type, podcastShow.fields, podcastShow.createdAt, podcastShow.updatedAt
        FROM egghead_ContentResource podcastShow
        WHERE podcastShow.deletedAt IS NULL
          ${publishedResourceSql("podcastShow")}
          AND ${podcastResourceCondition("podcastShow")}
          AND ${contentResourceKindSql("podcastShow")} = 'podcast-show'
          AND ${showSlugSql} = ?
        ORDER BY podcastShow.updatedAt DESC, podcastShow.createdAt DESC, podcastShow.id ASC
        LIMIT 1
      `,
      [slug],
    );
    const podcastShow = showRows[0];
    if (!podcastShow) return null;

    const showFields = fieldsFromJson(podcastShow.fields);
    const showSlug = stringField(showFields, "slug") ?? slug;
    const showTitle = stringField(showFields, "title") ?? "Untitled podcast";
    const show = {
      id: podcastShow.id,
      title: showTitle,
      slug: showSlug,
    };

    const episodeSlugSql = await contentResourceSlugSql(connection, "episode");
    const [episodeRows] = await connection.execute<LinkedPodcastEpisodeRow[]>(
      `
        SELECT
          episode.id,
          episode.type,
          episode.fields,
          episode.createdAt,
          episode.updatedAt,
          link.position
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource episode
          ON episode.id = link.resourceId
         AND episode.deletedAt IS NULL
         ${publishedResourceSql("episode")}
        WHERE link.resourceOfId = ?
          AND ${podcastResourceCondition("episode")}
          AND ${contentResourceKindSql("episode")} = 'podcast-episode'
          AND ${episodeSlugSql} IS NOT NULL
          AND ${episodeSlugSql} != ''
        ORDER BY link.position ASC, episode.createdAt DESC, episode.id ASC
      `,
      [podcastShow.id],
    );
    const episodes = episodeRows
      .map((row) => toPodcastEpisode(row, show))
      .filter((episode): episode is PodcastEpisode => episode !== null);

    return {
      id: podcastShow.id,
      title: showTitle,
      slug: showSlug,
      description: descriptionField(showFields),
      body: markdownField(showFields),
      canonicalPath: canonicalPodcastPath(showSlug, null, "podcast-show"),
      episodeCount: numberField(showFields, "episodeCount") ?? episodes.length,
      episodes,
    };
  } finally {
    await connection.end();
  }
}

export function getPodcastEpisode(show: PodcastShowForPage, episodeSlug: string) {
  return show.episodes.find((episode) => episode.slug === episodeSlug) ?? null;
}

export async function getPodcastEpisodeBySlug(slug: string): Promise<PodcastEpisode | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-podcast-episode:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const episodeSlugSql = await contentResourceSlugSql(connection, "episode");
    const [rows] = await connection.execute<PodcastEpisodeLookupRow[]>(
      `
        SELECT
          episode.id,
          episode.type,
          episode.fields,
          episode.createdAt,
          episode.updatedAt,
          podcastShow.id AS podcastShowId,
          podcastShow.fields AS podcastShowFields
        FROM egghead_ContentResource episode
        LEFT JOIN egghead_ContentResourceResource link
          ON link.resourceId = episode.id
        LEFT JOIN egghead_ContentResource podcastShow
          ON podcastShow.id = link.resourceOfId
         AND podcastShow.deletedAt IS NULL
         ${publishedResourceSql("podcastShow")}
         AND ${podcastResourceCondition("podcastShow")}
         AND ${contentResourceKindSql("podcastShow")} = 'podcast-show'
        WHERE episode.deletedAt IS NULL
          ${publishedResourceSql("episode")}
          AND ${podcastResourceCondition("episode")}
          AND ${contentResourceKindSql("episode")} = 'podcast-episode'
          AND ${episodeSlugSql} = ?
        ORDER BY
          CASE WHEN podcastShow.id IS NULL THEN 1 ELSE 0 END ASC,
          episode.updatedAt DESC,
          episode.createdAt DESC,
          episode.id ASC
        LIMIT 1
      `,
      [slug],
    );
    const episode = rows[0];
    return episode ? podcastEpisodeFromLookup(episode, slug) : null;
  } finally {
    await connection.end();
  }
}

export async function getPodcastShowStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-podcast-show-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const showSlugSql = await contentResourceSlugSql(connection, "podcastShow");
    const [rows] = await connection.execute<Array<RowDataPacket & { slug: string }>>(
      `
        SELECT podcast_show_slug.slug
        FROM (
          SELECT ${showSlugSql} AS slug, podcastShow.createdAt
          FROM egghead_ContentResource podcastShow
          WHERE podcastShow.deletedAt IS NULL
            ${publishedResourceSql("podcastShow")}
            AND ${podcastResourceCondition("podcastShow")}
            AND ${contentResourceKindSql("podcastShow")} = 'podcast-show'
            AND ${showSlugSql} IS NOT NULL
            AND ${showSlugSql} != ''
        ) podcast_show_slug
        GROUP BY podcast_show_slug.slug
        ORDER BY MAX(podcast_show_slug.createdAt) DESC
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}

export async function getPodcastEpisodeStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-podcast-episode-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const showSlugSql = await contentResourceSlugSql(connection, "podcastShow");
    const episodeSlugSql = await contentResourceSlugSql(connection, "episode");
    const [rows] = await connection.execute<PodcastStaticParamRow[]>(
      `
        SELECT
          ${showSlugSql} AS collection,
          ${episodeSlugSql} AS entry
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource podcastShow
          ON podcastShow.id = link.resourceOfId
         AND podcastShow.deletedAt IS NULL
         ${publishedResourceSql("podcastShow")}
        JOIN egghead_ContentResource episode
          ON episode.id = link.resourceId
         AND episode.deletedAt IS NULL
         ${publishedResourceSql("episode")}
        WHERE ${podcastResourceCondition("podcastShow")}
          AND ${contentResourceKindSql("podcastShow")} = 'podcast-show'
          AND ${podcastResourceCondition("episode")}
          AND ${contentResourceKindSql("episode")} = 'podcast-episode'
          AND ${showSlugSql} IS NOT NULL
          AND ${showSlugSql} != ''
          AND ${episodeSlugSql} IS NOT NULL
          AND ${episodeSlugSql} != ''
        GROUP BY ${showSlugSql}, ${episodeSlugSql}
        ORDER BY MIN(link.position) ASC
      `,
    );

    return rows.map((row) => ({
      collection: row.collection,
      entry: row.entry,
    }));
  } finally {
    await connection.end();
  }
}
