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
        <MarkdownContent label={`${eyebrow} body`}>{resource.body}</MarkdownContent>
      </Stack>
    </Container>
  );
}
