import type { Metadata } from "next";

import {
  codeOfConductMarkdown,
  codeOfConductTitle,
} from "../../static-pages/code-of-conduct-content";
import { StaticMarkdownPage } from "../../static-pages/static-markdown-page";

export const metadata: Metadata = {
  title: `${codeOfConductTitle} | egghead`,
  description: "The egghead community code of conduct.",
  alternates: { canonical: "https://egghead.io/code-of-conduct" },
};

export default function Page() {
  return <StaticMarkdownPage markdown={codeOfConductMarkdown} title={codeOfConductTitle} />;
}
