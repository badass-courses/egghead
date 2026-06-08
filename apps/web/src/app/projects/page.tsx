import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("project");

export default async function ProjectsIndexPage() {
  const index = await getContentIndex("project");

  return <ContentIndexPage index={index} />;
}
