import Link from "next/link";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

export default function NotFound() {
  return (
    <Container as="main">
      <SectionHeader
        description="We couldn't find that page. It may have moved, or the link may be wrong."
        title="Page not found"
      />
      <p>
        <Link href="/q">Search egghead</Link> or go <Link href="/">home</Link>.
      </p>
    </Container>
  );
}
