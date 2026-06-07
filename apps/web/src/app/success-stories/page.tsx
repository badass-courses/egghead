import { permanentRedirect } from "next/navigation";

export default function SuccessStoriesIndexRedirectPage() {
  permanentRedirect("/q?type=success-story");
}
