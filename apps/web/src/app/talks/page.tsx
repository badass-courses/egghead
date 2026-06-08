import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("talk");

export default async function TalksIndexPage() {
  const index = await getContentIndex("talk");

  return <ContentIndexPage index={index} />;
}
