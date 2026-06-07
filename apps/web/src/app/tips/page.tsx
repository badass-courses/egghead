import { permanentRedirect } from "next/navigation";

export default function TipsIndexRedirectPage() {
  permanentRedirect("/q?type=tip");
}
