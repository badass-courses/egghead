import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("course");

export default async function CoursesIndexPage() {
  const index = await getContentIndex("course");

  return <ContentIndexPage index={index} />;
}
