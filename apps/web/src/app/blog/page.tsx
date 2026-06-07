import { permanentRedirect } from "next/navigation";

export default function BlogIndexRedirectPage() {
  permanentRedirect("/q?type=article");
}
