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
        <SectionHeader description={resource.description} eyebrow={eyebrow} title={resource.title} />

        <dl className="egghead-course-facts" aria-label={`${eyebrow} facts`}>
          <div>
            <dt>Access</dt>
            <dd data-content-access="public">Public</dd>
          </div>
          <div>
            <dt>Disposition</dt>
            <dd data-public-route-disposition={resource.sourceDisposition}>
              {resource.sourceDisposition}
            </dd>
          </div>
          <div>
            <dt>Source path</dt>
            <dd data-public-route-path={resource.sourcePath}>{resource.sourcePath}</dd>
          </div>
        </dl>
      </Stack>
    </Container>
  );
}
