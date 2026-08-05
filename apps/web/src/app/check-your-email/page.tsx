import { notFound } from "next/navigation";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { getEggheadRuntime } from "../../db/local-docker";

export default function CheckYourEmailPage() {
  if (getEggheadRuntime() === "production") notFound();

  return (
    <Container as="main" size="narrow">
      <SectionHeader
        description="Use the link in the email to finish signing in. The link can only be used once."
        eyebrow="One more step"
        title="Check your email"
      />
      <p className="max-w-md text-muted-foreground">
        It may take a minute to arrive. If you don&apos;t see it, check your spam folder or return
        to the sign-in page and request another link.
      </p>
    </Container>
  );
}
