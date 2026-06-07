import { Container, SectionHeader, Stack } from "@egghead/ui";

export default function Home() {
  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          eyebrow="Phase 0"
          title="egghead"
          description="Standalone CourseBuilder integration app boundary is active."
        />
        <div className="egghead-prose">
          <p>
            This local shell proves the package, schema, API, auth, and behavior
            harness boundary before content/auth MVE execution.
          </p>
        </div>
      </Stack>
    </Container>
  );
}
