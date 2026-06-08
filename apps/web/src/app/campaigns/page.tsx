import { ContentIndexPage } from "../../content/content-index-page";
import { contentIndexMetadata, getContentIndex } from "../../content/content-index";

export const metadata = contentIndexMetadata("campaign");

export default async function CampaignsIndexPage() {
  const index = await getContentIndex("campaign");

  return <ContentIndexPage index={index} />;
}
