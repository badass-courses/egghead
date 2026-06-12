import Image from "next/image";
import Link from "next/link";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { MarkdownContent } from "./markdown-content";
import type { PodcastEpisode, PodcastShowForPage } from "./podcast";

function PodcastEpisodeMedia({ episode }: { episode: PodcastEpisode }) {
  const mediaUrl = episode.mediaUrl ?? episode.audioUrl;
  const videoUrl = episode.videoHlsUrl ?? episode.videoDashUrl;

  if (videoUrl) {
    return (
      <video
        aria-label={`${episode.title} video`}
        className="egghead-video"
        controls
        poster={episode.thumbnailUrl ?? episode.imageUrl ?? undefined}
        preload="metadata"
        src={videoUrl}
      >
        <track kind="captions" />
      </video>
    );
  }

  if (mediaUrl) {
    return (
      <audio
        aria-label={`${episode.title} audio`}
        className="egghead-audio"
        controls
        preload="metadata"
        src={mediaUrl}
      >
        <track kind="captions" />
      </audio>
    );
  }

  if (episode.imageUrl) {
    return (
      <Image
        alt=""
        className="egghead-public-image"
        height={675}
        src={episode.imageUrl}
        unoptimized
        width={1200}
      />
    );
  }

  return null;
}

function PodcastEpisodeLink({
  activeEpisodeSlug,
  episode,
}: {
  activeEpisodeSlug: string | undefined;
  episode: PodcastEpisode;
}) {
  const active = episode.slug === activeEpisodeSlug;

  return (
    <li className="egghead-collection-nav-item">
      <Link
        aria-current={active ? "page" : undefined}
        className={active ? "egghead-collection-nav-link-active" : undefined}
        data-active-episode={active ? "true" : "false"}
        href={episode.canonicalPath}
      >
        <span>{episode.title}</span>
        {episode.duration ? <small>{Math.round(episode.duration / 60)} min</small> : null}
      </Link>
    </li>
  );
}

function PodcastEpisodeNavigation({
  activeEpisodeSlug,
  show,
}: {
  activeEpisodeSlug: string | undefined;
  show: PodcastShowForPage;
}) {
  return (
    <aside
      className="egghead-collection-nav min-[960px]:sticky-rail min-[960px]:overflow-y-auto min-[960px]:overscroll-contain scroll-fade"
      aria-label={`${show.title} episodes`}
    >
      <Link className="egghead-collection-nav-title" href={show.canonicalPath}>
        {show.title}
      </Link>
      <ol className="egghead-collection-nav-list">
        {show.episodes.map((episode) => (
          <PodcastEpisodeLink
            activeEpisodeSlug={activeEpisodeSlug}
            episode={episode}
            key={episode.id}
          />
        ))}
      </ol>
    </aside>
  );
}

export async function PodcastShowPageStatic({ show }: { show: PodcastShowForPage }) {
  "use cache";

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader description={show.description} eyebrow="Podcast" title={show.title} />
        <MarkdownContent label="Podcast body">{show.body}</MarkdownContent>
        <section aria-label={`${show.title} episodes`} className="egghead-collection-nav">
          <ol className="egghead-collection-nav-list">
            {show.episodes.map((episode) => (
              <li className="egghead-collection-nav-item" key={episode.id}>
                <Link href={episode.canonicalPath}>{episode.title}</Link>
                {episode.description ? <p>{episode.description}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      </Stack>
    </Container>
  );
}

export async function PodcastEpisodePageStatic({
  episode,
  show,
}: {
  episode: PodcastEpisode;
  show: PodcastShowForPage;
}) {
  "use cache";

  return (
    <Container as="main" size="wide">
      <div className="egghead-collection-lesson-layout">
        <div className="egghead-collection-lesson-main">
          <Stack gap="loose">
            <SectionHeader
              description={episode.description}
              eyebrow="Podcast episode"
              title={episode.title}
            />
            <PodcastEpisodeMedia episode={episode} />
            <MarkdownContent label="Podcast episode body">{episode.body}</MarkdownContent>
          </Stack>
        </div>
        <PodcastEpisodeNavigation activeEpisodeSlug={episode.slug} show={show} />
      </div>
    </Container>
  );
}
