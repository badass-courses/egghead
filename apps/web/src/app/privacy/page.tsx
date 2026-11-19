import type { Metadata } from "next";

import { termsMarkdown, termsTitle } from "../../static-pages/terms-content";
import { StaticMarkdownPage } from "../../static-pages/static-markdown-page";

export const metadata: Metadata = {
  title: `${termsTitle} | egghead`,
  description: "egghead.io terms of service and privacy.",
  alternates: { canonical: "https://egghead.io/privacy" },
};

export default function Page() {
  return <StaticMarkdownPage markdown={termsMarkdown} title={termsTitle} />;
}
