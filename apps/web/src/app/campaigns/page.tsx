import { permanentRedirect } from "next/navigation";

export default function CampaignsIndexRedirectPage() {
  permanentRedirect("/q?type=campaign");
}
