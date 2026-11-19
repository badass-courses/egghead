import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { headingAnchor } from "./heading-anchor";

function AnchoredHeading({ children }: { children?: ReactNode }) {
  if (typeof children !== "string") return <h3>{children}</h3>;
  const { text, id } = headingAnchor(children);
  return <h3 id={id}>{text}</h3>;
}

export async function StaticMarkdownPage({ title, markdown }: { title: string; markdown: string }) {
  "use cache";

  return (
    <Container as="main">
      <SectionHeader title={title} />
      <section aria-label={title} className="egghead-prose egghead-markdown">
        <ReactMarkdown components={{ h3: AnchoredHeading }}>{markdown}</ReactMarkdown>
      </section>
    </Container>
  );
}
