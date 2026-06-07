import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

export default function Home() {
  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description="Standalone CourseBuilder integration app boundary is active."
          eyebrow="Phase 0"
          title="egghead"
        />
        <div className="egghead-prose">
          <p>
            This local shell proves the package, schema, API, auth, and behavior harness boundary
            before content/auth MVE execution.
          </p>
        </div>
      </Stack>
    </Container>
  );
}
