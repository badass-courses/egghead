import { permanentRedirect } from "next/navigation";

export default function PodcastIndexRedirectPage() {
  permanentRedirect("/q?type=podcast");
}
