import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("success-story");

export default async function SuccessStoriesIndexPage() {
  const index = await getContentIndex("success-story");

  return <ContentIndexPage index={index} />;
}
