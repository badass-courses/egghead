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
 * never be used to create an account.
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
    if (match) return match.email;
  }

  return verified.find((email) => email.primary)?.email ?? null;
}

async function fetchGithubJson(url: string, accessToken: string | undefined): Promise<unknown> {
  if (!accessToken) throw new Error("GitHub sign-in returned no access token");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "authjs",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}`);
  }

  return response.json();
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
 * Email account linking is off. Auth.js then resolves a GitHub sign-in only by
 * the `(github, GitHub user id)` account row. It links a GitHub identity to an
 * existing user only while that user is already signed in, for example from
 * the profile "Connect GitHub" action after a magic-link sign-in. A GitHub
 * sign-in whose email matches an unlinked existing user is refused with
 * `OAuthAccountNotLinked` instead of taking that user over.
 */
export function createGithubProvider({ clientId, clientSecret }: GithubProviderOptions) {
  return GithubProvider({
    clientId,
    clientSecret,
    allowDangerousEmailAccountLinking: false,
    userinfo: {
      url: `${GITHUB_API_BASE_URL}/user`,
      async request({ tokens }: { tokens: { access_token?: string } }) {
        const profile = await fetchGithubJson(`${GITHUB_API_BASE_URL}/user`, tokens.access_token);
        if (!isGithubProfile(profile)) throw new Error("GitHub returned an invalid user profile");

        const emails = await fetchGithubJson(
          `${GITHUB_API_BASE_URL}/user/emails`,
          tokens.access_token,
        );
        const email = selectVerifiedGithubEmail(
          profile.email,
          Array.isArray(emails) ? emails.filter(isGithubEmail) : [],
        );

        if (!email) throw new Error("GitHub account has no verified email address");

        return { ...profile, email };
      },
    },
  });
}
