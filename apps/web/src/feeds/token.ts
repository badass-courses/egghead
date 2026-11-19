// Token auth for member feeds, ported from Rails
// ApplicationController#authenticate_user_from_token! plus the CanCan
// `pro_user_permissions` gate (pro and not trialing, or instructor).
//
// Rails URL shape: ?user_email=<email>&user_token=<users.authentication_token>
// Rails behaviour: unknown email or token mismatch -> 403; signed in but not
// a member -> CanCan redirect to "/". Feed readers cannot follow that
// redirect usefully, so CB answers 403 for every refusal.

import { createHash } from "node:crypto";

export const FEED_TOKEN_PARAM = "user_token";
export const FEED_EMAIL_PARAM = "user_email";

export type FeedTokenRecord = {
  userId: string;
  /** The CB user's email today. Can be null for CB users without one. */
  email: string | null;
  /** SHA-256 of the Rails email captured at import (lowercased, trimmed). */
  railsEmailSha256: string | null;
  revokedAt: Date | null;
};

export type FeedTokenStore = {
  findByTokenSha256: (tokenSha256: string) => Promise<FeedTokenRecord | null>;
};

export type FeedMembershipCheck = (userId: string) => Promise<boolean>;

export type FeedAuthRefusal =
  | "missing_credentials"
  | "unknown_token"
  | "email_mismatch"
  | "revoked_token"
  | "not_a_member";

export type FeedAuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 403; reason: FeedAuthRefusal };

export function hashFeedToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function refuse(reason: FeedAuthRefusal): FeedAuthResult {
  return { ok: false, status: 403, reason };
}

// Devise stored emails lowercased and stripped (case_insensitive_keys,
// strip_whitespace_keys), and Rails' find_by_email on Postgres matched them
// exactly. Matching case-insensitively accepts every URL Rails accepted.
// The token itself is compared exactly (hashed as given), like secure_compare.
function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** SHA-256 of a normalized email, the same value the Rails export computes in SQL. */
export function hashFeedEmail(email: string) {
  return createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");
}

/**
 * The URL carries the email the subscriber had in Rails when they copied the
 * feed URL. CB may hold a different (or no) email for the same person by flip
 * time, so either the Rails email captured at import or the CB email passes.
 */
export function feedEmailMatches(record: FeedTokenRecord, urlEmail: string) {
  if (record.railsEmailSha256 && record.railsEmailSha256 === hashFeedEmail(urlEmail)) return true;
  return record.email != null && normalizeEmail(record.email) === normalizeEmail(urlEmail);
}

export async function authenticateFeedRequest(
  params: URLSearchParams,
  deps: { store: FeedTokenStore; isMember: FeedMembershipCheck },
): Promise<FeedAuthResult> {
  const email = params.get(FEED_EMAIL_PARAM)?.trim();
  const token = params.get(FEED_TOKEN_PARAM)?.trim();
  if (!email || !token) return refuse("missing_credentials");

  const record = await deps.store.findByTokenSha256(hashFeedToken(token));
  if (!record) return refuse("unknown_token");
  if (!feedEmailMatches(record, email)) return refuse("email_mismatch");
  if (record.revokedAt) return refuse("revoked_token");
  if (!(await deps.isMember(record.userId))) return refuse("not_a_member");

  return { ok: true, userId: record.userId };
}

/** Roles that Rails' instructor/staff abilities map to in CourseBuilder. */
const FEED_STAFF_ROLES = new Set(["admin", "contributor"]);

export function feedRoleGrantsAccess(role: string | null | undefined) {
  return role != null && FEED_STAFF_ROLES.has(role);
}
