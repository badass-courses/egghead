import type { Metadata } from "next";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

type TalkArchivePageProps = {
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

async function talkSlugFromParams(params: TalkArchivePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateMetadata({ params }: TalkArchivePageProps): Promise<Metadata> {
  const slug = await talkSlugFromParams(params);
  const title = titleFromSlug(slug);

  return {
    title: `${title} | egghead talk archive`,
    description: "Archived egghead talk URL preserved for routing and search continuity.",
    alternates: {
      canonical: `https://egghead.io/talks/${slug}`,
    },
    robots: {
      index: false,
      follow: true,
    },
  };
}

export default async function TalkArchivePage({ params }: TalkArchivePageProps) {
  const slug = await talkSlugFromParams(params);
  const title = titleFromSlug(slug);

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description="This talk URL is preserved as a static archive entry while the standalone Egghead app keeps CourseBuilder-owned content and access behavior focused."
          eyebrow="Talk archive"
          title={title}
        />

        <dl className="egghead-course-facts" aria-label="Talk archive facts">
          <div>
            <dt>Disposition</dt>
            <dd data-public-route-disposition="static_archive">Static archive</dd>
          </div>
          <div>
            <dt>Source path</dt>
            <dd data-public-route-path={`/talks/${slug}`}>/talks/{slug}</dd>
          </div>
        </dl>
      </Stack>
    </Container>
  );
}
