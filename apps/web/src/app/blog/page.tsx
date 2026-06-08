import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("article");

export default async function BlogIndexPage() {
  const index = await getContentIndex("article");

  return <ContentIndexPage index={index} />;
}
