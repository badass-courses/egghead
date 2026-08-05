import { getCurrentUserWithAccess } from "../coursebuilder/current-user";
import { SiteNav } from "./site-nav";

export async function SiteNavWithAccount() {
  const account = await getCurrentUserWithAccess();

  return (
    <SiteNav
      accountState={account ? "authenticated" : "anonymous"}
      {...(account ? { account } : {})}
    />
  );
}
