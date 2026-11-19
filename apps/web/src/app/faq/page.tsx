import type { Metadata } from "next";

import { faqMarkdown, faqTitle } from "../../static-pages/faq-content";
import { StaticMarkdownPage } from "../../static-pages/static-markdown-page";

export const metadata: Metadata = {
  title: `${faqTitle} | egghead`,
  description: "Answers to common egghead billing, membership, and team questions.",
  alternates: { canonical: "https://egghead.io/faq" },
};

export default function Page() {
  return <StaticMarkdownPage markdown={faqMarkdown} title={faqTitle} />;
}
