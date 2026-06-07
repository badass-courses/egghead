import { permanentRedirect } from "next/navigation";

export default function TalksIndexRedirectPage() {
  permanentRedirect("/q?type=talk");
}
