// Account state for the site nav, read by the browser after hydration.
//
// The root layout must not read the session on the server. Under
// cacheComponents, a notFound() on any generateStaticParams route renders the
// error tree in Next's legacy prerender store. A cookie read there sets
// revalidate to 0, and Next 16 then answers 500 instead of 404. The nav fetches
// this payload client-side instead.

export type NavAccountState = {
  displayName: string | null;
  hasProSubscription: boolean;
};

export const ANONYMOUS_NAV_ACCOUNT: NavAccountState = {
  displayName: null,
  hasProSubscription: false,
};

export function navAccountState(
  account: { displayName: string; hasProSubscription: boolean } | null,
): NavAccountState {
  if (!account) return ANONYMOUS_NAV_ACCOUNT;
  return { displayName: account.displayName, hasProSubscription: account.hasProSubscription };
}

export function navAccountResponse(state: NavAccountState) {
  return Response.json(state, {
    status: 200,
    headers: { "cache-control": "private, no-store" },
  });
}

export function parseNavAccountState(value: unknown): NavAccountState | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("displayName" in value) || !("hasProSubscription" in value)) return null;
  const { displayName, hasProSubscription } = value;
  if (displayName !== null && typeof displayName !== "string") return null;
  if (typeof hasProSubscription !== "boolean") return null;
  return { displayName, hasProSubscription };
}

// The nav refreshes on navigation or window focus at most once a minute.
export const NAV_ACCOUNT_REFRESH_MS = 60_000;

export function shouldRefreshNavAccount(lastStartedAt: number | null, now: number): boolean {
  return lastStartedAt === null || now - lastStartedAt >= NAV_ACCOUNT_REFRESH_MS;
}
