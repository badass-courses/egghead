import { and, eq } from "drizzle-orm";
import type { VerificationToken } from "next-auth/adapters";

import { getEggheadDatabase } from "../db/adapter";
import { assertAccountWritesAllowed } from "../db/local-docker";
import { verificationTokens } from "../db/schema";

// The published CourseBuilder adapter permits repeat clicks for 90 seconds.
// Auth.js needs a single-use consume: serialize lookup and deletion in one transaction.
export async function consumeAuthVerificationToken(input: {
  identifier: string;
  token: string;
}): Promise<VerificationToken | null> {
  assertAccountWritesAllowed();
  if (!input.identifier || !input.token) return null;

  return getEggheadDatabase().transaction(async (transaction) => {
    const match = and(
      eq(verificationTokens.identifier, input.identifier),
      eq(verificationTokens.token, input.token),
    );
    const [stored] = await transaction.select().from(verificationTokens).where(match).for("update");
    if (!stored) return null;
    await transaction.delete(verificationTokens).where(match);
    if (stored.expires.getTime() <= Date.now()) return null;
    return { identifier: stored.identifier, token: stored.token, expires: stored.expires };
  });
}
