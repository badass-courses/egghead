// Typesense reader for /i/:slug/rss.xml. Same query egghead-next ran
// (src/lib/instructor-feed.ts), against the legacy content_production
// collection the search page already reads.

import { normalizeInstructorDisplayName } from "../content/encoding";
import type { LegacySearchIndexDocument } from "../content/search-document";
import {
  createEggheadTypesenseSearchClient,
  isEggheadTypesenseSearchConfigured,
} from "../content/typesense";
import {
  INSTRUCTOR_PODCAST_LIMIT,
  isInstructorSlug,
  parseInstructorPodcastDocuments,
  type InstructorPodcastDocument,
} from "./instructor-podcast";

export class InstructorPodcastSourceUnavailable extends Error {}

export type InstructorPodcastSource = (slug: string) => Promise<{
  instructorName: string;
  documents: InstructorPodcastDocument[];
} | null>;

/**
 * The collection this feed reads. It is independent of the search page's
 * TYPESENSE_COLLECTION_NAME: search may move to the canonical collection,
 * but only the legacy `content_production` documents carry egghead-next's
 * `path` values, and those are the GUIDs. It shares the search host and key.
 */
export const INSTRUCTOR_FEED_COLLECTION_ENV = "EGGHEAD_INSTRUCTOR_FEED_TYPESENSE_COLLECTION";
export const INSTRUCTOR_FEED_DEFAULT_COLLECTION = "content_production";

export function instructorFeedCollection() {
  return process.env[INSTRUCTOR_FEED_COLLECTION_ENV]?.trim() || INSTRUCTOR_FEED_DEFAULT_COLLECTION;
}

/** Without a Typesense host and search key this refuses (503, retryable). */
export const typesenseInstructorPodcastSource: InstructorPodcastSource = async (slug) => {
  if (!isInstructorSlug(slug)) return null;
  if (!isEggheadTypesenseSearchConfigured()) {
    throw new InstructorPodcastSourceUnavailable(
      "The /i/:slug/rss.xml feed needs NEXT_PUBLIC_TYPESENSE_HOST and NEXT_PUBLIC_TYPESENSE_API_KEY.",
    );
  }

  const response = await createEggheadTypesenseSearchClient()
    .collections<LegacySearchIndexDocument>(instructorFeedCollection())
    .documents()
    .search({
      q: "",
      query_by: "title,description,_tags,instructor_name,contributors",
      // isInstructorSlug allows only [a-z0-9-], so the slug cannot break out of the filter.
      filter_by: `instructor.slug:=${slug}`,
      sort_by: "published_at_timestamp:desc",
      per_page: INSTRUCTOR_PODCAST_LIMIT,
    });

  const documents = parseInstructorPodcastDocuments(
    (response.hits ?? []).map((hit) => hit.document),
  );
  // egghead-next returned 404 for an unknown instructor; with no documents we
  // cannot tell an unknown slug from an empty one, so both are 404.
  if (documents.length === 0) return null;
  const name = documents.find((document) => document.instructor_name)?.instructor_name;

  return {
    instructorName: name ? normalizeInstructorDisplayName(name) : slug,
    documents,
  };
};
