import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";

import { getPodcastEpisodeBySlug, getPodcastShowBySlug } from "../../../content/podcast";
import {
  getPublicContentBySlug,
  getPublicContentStaticParams,
} from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type PodcastPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: PodcastPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["podcast"]);
}

export async function generateMetadata({ params }: PodcastPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  const podcastShow = await getPodcastShowBySlug(slug);

  if (podcastShow) {
    return {
      title: `${podcastShow.title} | egghead`,
      description: podcastShow.description,
      alternates: {
        canonical: `https://egghead.io${podcastShow.canonicalPath}`,
      },
    };
  }

  const podcastEpisode = await getPodcastEpisodeBySlug(slug);

  if (podcastEpisode) {
    return {
      title: `${podcastEpisode.title} | egghead`,
      description: podcastEpisode.description,
      alternates: {
        canonical: `https://egghead.io${podcastEpisode.canonicalPath}`,
      },
    };
  }

  return getPublicContentMetadata({
    canonicalPrefix: "/podcasts",
    families: ["podcast"],
    label: "Podcast",
    slug,
  });
}

export default async function PodcastPage({ params }: PodcastPageProps) {
  const slug = await slugFromParams(params);
  const podcastShow = await getPodcastShowBySlug(slug);

  if (podcastShow) permanentRedirect(podcastShow.canonicalPath);

  const podcastEpisode = await getPodcastEpisodeBySlug(slug);

  if (podcastEpisode) permanentRedirect(podcastEpisode.canonicalPath);

  const publicPodcast = await getPublicContentBySlug(slug, ["podcast"]);

  if (publicPodcast) permanentRedirect(publicPodcast.canonicalPath);

  return renderPublicContentRoute({ eyebrow: "Podcast", families: ["podcast"], slug });
}
