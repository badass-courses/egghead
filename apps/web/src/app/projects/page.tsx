import { permanentRedirect } from "next/navigation";

export default function ProjectsIndexRedirectPage() {
  permanentRedirect("/q?type=project");
}
