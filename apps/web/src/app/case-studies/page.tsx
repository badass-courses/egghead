import { permanentRedirect } from "next/navigation";

export default function CaseStudiesIndexRedirectPage() {
  permanentRedirect("/q?type=case-study");
}
