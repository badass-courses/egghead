import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import type { PublicContentResource } from "./public-resource";

export function PublicContentPage({
  eyebrow,
  resource,
}: {
  eyebrow: string;
  resource: PublicContentResource;
}) {
  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description={resource.description}
          eyebrow={eyebrow}
          title={resource.title}
        />
      </Stack>
    </Container>
  );
}
