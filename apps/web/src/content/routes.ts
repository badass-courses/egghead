export type PublicContentFamily =
  | "article"
  | "campaign"
  | "case-study"
  | "podcast"
  | "success-story"
  | "talk";

export const STANDALONE_PUBLIC_CONTENT_FAMILIES = [
  "article",
  "campaign",
  "case-study",
  "podcast",
  "success-story",
  "talk",
] as const satisfies readonly PublicContentFamily[];

export function standaloneContentPath(slug: string) {
  return `/${slug}`;
}

export function collectionPath(collectionSlug: string) {
  return `/${collectionSlug}`;
}

export function collectionEntryPath(collectionSlug: string, entrySlug: string) {
  return `/${collectionSlug}/${entrySlug}`;
}

export function canonicalPodcastPath(
  slug: string,
  podcastShowSlug?: string | null,
  contentResourceKind?: string | null,
) {
  if (podcastShowSlug && contentResourceKind !== "podcast-show") {
    return collectionEntryPath(podcastShowSlug, slug);
  }

  return standaloneContentPath(slug);
}

export function legacyCoursePath(slug: string) {
  return `/courses/${slug}`;
}

export function legacyLessonPath(slug: string) {
  return `/lessons/${slug}`;
}

export function legacyLessonEmbedPath(slug: string) {
  return `/lessons/${slug}/embed`;
}

export function legacyPublicContentPath(family: PublicContentFamily, slug: string) {
  if (family === "article") return `/blog/${slug}`;
  if (family === "podcast") return `/podcasts/${slug}`;
  if (family === "talk") return `/talks/${slug}`;
  if (family === "case-study") return `/case-studies/${slug}`;
  if (family === "success-story") return `/success-stories/${slug}`;
  return `/campaigns/${slug}`;
}

export function canonicalPublicContentPath(_family: PublicContentFamily, slug: string) {
  return standaloneContentPath(slug);
}
