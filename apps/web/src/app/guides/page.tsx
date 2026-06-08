import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("guide");

export default async function GuidesIndexPage() {
  const index = await getContentIndex("guide");

  return <ContentIndexPage index={index} />;
}
