import { getCurrentUser } from "../coursebuilder/current-user";
import { SiteNav } from "./site-nav";

export async function SiteNavWithAccount() {
  const currentUser = await getCurrentUser();

  return <SiteNav accountState={currentUser ? "authenticated" : "anonymous"} />;
}
