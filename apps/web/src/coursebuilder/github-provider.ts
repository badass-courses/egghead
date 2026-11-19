import GithubProvider, { type GitHubEmail, type GitHubProfile } from "@auth/core/providers/github";

const GITHUB_API_BASE_URL = "https://api.github.com";

type GithubProviderOptions = {
  clientId: string;
  clientSecret: string;
};

function isGithubEmail(value: unknown): value is GitHubEmail {
  if (typeof value !== "object" || value === null) return false;

  return (
    "email" in value &&
    typeof value.email === "string" &&
    "primary" in value &&
    typeof value.primary === "boolean" &&
    "verified" in value &&
    typeof value.verified === "boolean"
  );
}

/**
 * Pick the email Auth.js may use for this GitHub identity.
 *
 * GitHub lets an account hold unverified addresses, and the stock Auth.js
 * provider falls back to the primary address without checking `verified`.
 * Only a verified address is returned here, so an unverified address can
 * never be used to create an account. The address comes back trimmed and
 * lowercased, so a case-only difference can't create a second user.
 */
export function selectVerifiedGithubEmail(
  profileEmail: string | null | undefined,
  emails: readonly GitHubEmail[],
): string | null {
  const verified = emails.filter((email) => email.verified);
  const normalizedProfileEmail = profileEmail?.trim().toLowerCase();

  if (normalizedProfileEmail) {
    const match = verified.find(
      (email) => email.email.trim().toLowerCase() === normalizedProfileEmail,
    );
    if (match) return normalizeEmail(match.email);
  }

  const primary = verified.find((email) => email.primary);
  return primary ? normalizeEmail(primary.email) : null;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** OAuth scope the provider needs: profile plus the `/user/emails` list. */
export const GITHUB_OAUTH_SCOPE = "read:user user:email";

/** `/login` error code for a GitHub sign-in with no verified email. */
export const GITHUB_EMAIL_UNVERIFIED_ERROR = "GithubEmailUnverified";

function githubRequest(url: string, accessToken: string | undefined) {
  if (!accessToken) throw new Error("GitHub sign-in returned no access token");

  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "authjs",
    },
  });
}

/**
 * The verified addresses GitHub reports for this token. A failed or malformed
 * response counts as "no verified email", which refuses the sign-in with a
 * clear message instead of an error.
 */
async function fetchGithubEmails(accessToken: string | undefined): Promise<GitHubEmail[]> {
  try {
    const response = await githubRequest(`${GITHUB_API_BASE_URL}/user/emails`, accessToken);
    if (!response.ok) return [];
    const emails: unknown = await response.json();
    return Array.isArray(emails) ? emails.filter(isGithubEmail) : [];
  } catch {
    return [];
  }
}

function isGithubProfile(value: unknown): value is GitHubProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "login" in value &&
    typeof value.login === "string"
  );
}

/**
 * GitHub sign-in for egghead.
 *
 * Email account linking is on by design (Joel, 2026-11-18: "a github account
 * with the same email is same person"). A GitHub sign-in first matches the
 * `(github, GitHub user id)` account row, then links to an existing user with
 * the same email. That rule holds only for an address GitHub has verified, so
 * this provider never hands Auth.js an unverified address. With no verified
 * address the profile email is null, and `createAuthConfig`'s `signIn`
 * callback sends the user to `/login?error=GithubEmailUnverified`.
 */
export function createGithubProvider({ clientId, clientSecret }: GithubProviderOptions) {
  return GithubProvider({
    clientId,
    clientSecret,
    allowDangerousEmailAccountLinking: true,
    authorization: { params: { scope: GITHUB_OAUTH_SCOPE } },
    userinfo: {
      url: `${GITHUB_API_BASE_URL}/user`,
      async request({ tokens }: { tokens: { access_token?: string } }) {
        const response = await githubRequest(`${GITHUB_API_BASE_URL}/user`, tokens.access_token);
        if (!response.ok) {
          throw new Error(`GitHub user request failed with status ${response.status}`);
        }
        const profile: unknown = await response.json();
        if (!isGithubProfile(profile)) throw new Error("GitHub returned an invalid user profile");

        const emails = await fetchGithubEmails(tokens.access_token);

        return { ...profile, email: selectVerifiedGithubEmail(profile.email, emails) };
      },
    },
  });
}
