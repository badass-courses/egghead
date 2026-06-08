import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("tip");

export default async function TipsIndexPage() {
  const index = await getContentIndex("tip");

  return <ContentIndexPage index={index} />;
}
