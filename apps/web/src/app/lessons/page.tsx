import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("lesson");

export default async function LessonsIndexPage() {
  const index = await getContentIndex("lesson");

  return <ContentIndexPage index={index} />;
}
