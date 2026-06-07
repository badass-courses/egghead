import type { Metadata } from "next";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

type PodcastArchivePageProps = {
  params: Promise<{
    slug: string;
  }>;
};

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function podcastSlugFromParams(params: PodcastArchivePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateMetadata({ params }: PodcastArchivePageProps): Promise<Metadata> {
  const slug = await podcastSlugFromParams(params);
  const title = titleFromSlug(slug);

  return {
    title: `${title} | egghead podcast archive`,
    description: "Archived egghead podcast URL preserved for routing and search continuity.",
    alternates: {
      canonical: `https://egghead.io/podcasts/${slug}`,
    },
    robots: {
      index: false,
      follow: true,
    },
  };
}

export default async function PodcastArchivePage({ params }: PodcastArchivePageProps) {
  const slug = await podcastSlugFromParams(params);
  const title = titleFromSlug(slug);

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description="This podcast URL is preserved as a static archive entry while feed and search surfaces move through the standalone Egghead app."
          eyebrow="Podcast archive"
          title={title}
        />

        <dl className="egghead-course-facts" aria-label="Podcast archive facts">
          <div>
            <dt>Disposition</dt>
            <dd data-public-route-disposition="static_archive">Static archive</dd>
          </div>
          <div>
            <dt>Source path</dt>
            <dd data-public-route-path={`/podcasts/${slug}`}>/podcasts/{slug}</dd>
          </div>
        </dl>
      </Stack>
    </Container>
  );
}
