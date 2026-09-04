import { logger } from "@coursebuilder/core/utils/logger";

import { assertProgressWritesAllowed } from "../db/local-docker";

export type AuthenticatedProgressClaimResult = {
  status: "claimed" | "empty" | "deferred" | "failed" | "claimed_cookie_retained";
  claimedLessonIds: string[];
};

// Progress is best-effort during authentication, not an account-write prerequisite.
// Do not even read claim cookies/content when the progress policy denies writes.
export async function claimProgressAfterAuthentication(
  claim: () => Promise<AuthenticatedProgressClaimResult>,
): Promise<AuthenticatedProgressClaimResult> {
  try {
    assertProgressWritesAllowed();
  } catch {
    logger.info("anonymous_progress_claim_deferred", { reason: "progress_writes_not_approved" });
    return { status: "deferred", claimedLessonIds: [] };
  }

  try {
    return await claim();
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown anonymous progress claim failure"),
      {
        operation: "claimAnonymousLessonCompletions",
        authenticationContinues: true,
        cookieCleared: false,
      },
    );
    return { status: "failed", claimedLessonIds: [] };
  }
}
