export const EGGHEAD_REHEARSAL_COHORT_COOKIE = "egghead_rehearsal_cohort";

export type RehearsalCohort =
  | "active_individual_subscriber"
  | "active_team_seat_learner"
  | "anonymous"
  | "bare_legacy_pro_quarantined"
  | "expired_canceled_subscriber"
  | "free_signed_in"
  | "instructor_admin_support"
  | "paid_course_purchaser"
  | "team_owner_admin";

export const REHEARSAL_COHORTS: RehearsalCohort[] = [
  "active_individual_subscriber",
  "paid_course_purchaser",
  "active_team_seat_learner",
  "team_owner_admin",
  "free_signed_in",
  "expired_canceled_subscriber",
  "bare_legacy_pro_quarantined",
  "instructor_admin_support",
  "anonymous",
];

export function normalizeRehearsalCohort(value: string | null): RehearsalCohort | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "active_all_access_user") return "active_individual_subscriber";
  if (normalized === "team_owner") return "team_owner_admin";
  if (normalized === "legacy_pro") return "bare_legacy_pro_quarantined";
  if (normalized === "staff") return "instructor_admin_support";

  return REHEARSAL_COHORTS.find((cohort) => cohort === normalized) ?? null;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }

  return null;
}

export function rehearsalCohortFromRequest(request: Request) {
  const fixture = request.headers.get("x-egghead-mve-fixture");
  const headerCohort = request.headers.get("x-egghead-rehearsal-cohort") ?? fixture;
  const cookieCohort = readCookie(request.headers.get("cookie"), EGGHEAD_REHEARSAL_COHORT_COOKIE);

  return normalizeRehearsalCohort(headerCohort ?? cookieCohort);
}
