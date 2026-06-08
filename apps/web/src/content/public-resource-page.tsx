import Image from "next/image";

import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { MarkdownContent } from "./markdown-content";
import type { PublicContentResource } from "./public-resource";

export async function PublicContentPage({
  eyebrow,
  resource,
}: {
  eyebrow: string;
  resource: PublicContentResource;
}) {
  "use cache";

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description={resource.description}
          eyebrow={eyebrow}
          title={resource.title}
        />
        {(resource.videoHlsUrl ?? resource.videoDashUrl) ? (
          <video
            aria-label={`${resource.title} video`}
            className="egghead-video"
            controls
            poster={resource.thumbnailUrl ?? resource.imageUrl ?? undefined}
            preload="metadata"
            src={resource.videoHlsUrl ?? resource.videoDashUrl ?? undefined}
          >
            <track kind="captions" />
          </video>
        ) : resource.mediaUrl ? (
          <audio
            aria-label={`${resource.title} audio`}
            className="egghead-audio"
            controls
            preload="metadata"
            src={resource.mediaUrl}
          >
            <track kind="captions" />
          </audio>
        ) : resource.imageUrl ? (
          <Image
            alt=""
            className="egghead-public-image"
            height={675}
            src={resource.imageUrl}
            unoptimized
            width={1200}
          />
        ) : null}
        <MarkdownContent label={`${eyebrow} body`}>{resource.body}</MarkdownContent>
      </Stack>
    </Container>
  );
}
