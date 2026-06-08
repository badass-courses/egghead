import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getCurrentUserFromRequest } from "../../coursebuilder/current-user";
import { getEggheadRuntime } from "../../db/local-docker";
import { REHEARSAL_COHORTS, type RehearsalCohort } from "../../coursebuilder/rehearsal-cohort";

const COHORT_LABELS: Record<RehearsalCohort, string> = {
  active_individual_subscriber: "Active subscriber",
  active_team_seat_learner: "Team learner",
  anonymous: "Sign out",
  bare_legacy_pro_quarantined: "Legacy pro",
  expired_canceled_subscriber: "Expired subscriber",
  free_signed_in: "Free account",
  instructor_admin_support: "Staff access",
  paid_course_purchaser: "Course purchaser",
  team_owner_admin: "Team owner",
};

async function CurrentLoginState() {
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/login", { headers: requestHeaders }),
  );

  if (!currentUser.user) return null;

  return (
    <div className="egghead-login-state">
      <p className="egghead-eyebrow">Current cohort</p>
      <p>{COHORT_LABELS[currentUser.user.cohort]}</p>
      <p>{currentUser.user.support.accessSummary}</p>
    </div>
  );
}

export default function LoginPage() {
  const runtime = getEggheadRuntime();

  if (runtime === "production") notFound();

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader
          description="Choose a redacted beta cohort backed by migrated CourseBuilder permissions."
          eyebrow="Beta"
          title="Sign in"
        />

        <Suspense fallback={null}>
          <CurrentLoginState />
        </Suspense>

        <div className="egghead-login-grid">
          {REHEARSAL_COHORTS.map((cohort) => (
            <form action="/api/rehearsal-login" key={cohort} method="post">
              <input name="cohort" type="hidden" value={cohort} />
              <input name="returnTo" type="hidden" value="/" />
              <button className="egghead-login-button" type="submit">
                {COHORT_LABELS[cohort]}
              </button>
            </form>
          ))}
        </div>
      </Stack>
    </Container>
  );
}
