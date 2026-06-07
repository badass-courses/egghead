import { permanentRedirect } from "next/navigation";

export default function GuidesIndexRedirectPage() {
  permanentRedirect("/q?type=guide");
}
