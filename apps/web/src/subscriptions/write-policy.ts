import { assertCommerceWritesAllowed } from "../db/local-docker";

export function assertMembershipWritesAllowed() {
  const safety = assertCommerceWritesAllowed();
  if (safety.runtime !== "local" || !safety.localDockerOnly)
    throw new Error("Membership lifecycle writes require local Docker");
  const token = process.env["STRIPE_SECRET_TOKEN"];
  if (!token || (!token.startsWith("sk_test_") && !token.startsWith("rk_test_")))
    throw new Error("Local membership writes require a Stripe test key");
}
