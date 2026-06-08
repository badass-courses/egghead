import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("case-study");

export default async function CaseStudiesIndexPage() {
  const index = await getContentIndex("case-study");

  return <ContentIndexPage index={index} />;
}
