import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { isGithubAuthConfigured } from "../../coursebuilder/auth-config";
import { getCurrentUserFromRequest } from "../../coursebuilder/current-user";
import { getEggheadRuntime } from "../../db/local-docker";
import { signIn, signOut } from "../../server/auth";

async function signInWithGithub() {
  "use server";

  await signIn("github", { redirectTo: "/" });
}

async function signOutOfEgghead() {
  "use server";

  await signOut({ redirectTo: "/" });
}

async function AccountState({ githubAuthConfigured }: { githubAuthConfigured: boolean }) {
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/login", { headers: requestHeaders }),
  );

  if (currentUser.user) {
    return (
      <>
        <SectionHeader
          description={
            currentUser.user.access.granted
              ? "Your membership access is active."
              : "You're signed in, but this account has no active membership access."
          }
          eyebrow="Account"
          title="You're signed in"
        />

        <form action={signOutOfEgghead} className="grid max-w-xs gap-3">
          <Button type="submit" variant="ghost">
            Sign out
          </Button>
        </form>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        description="Use your GitHub account to continue."
        eyebrow="Account"
        title="Sign in to egghead"
      />

      {githubAuthConfigured ? (
        <form action={signInWithGithub} className="grid max-w-xs gap-3">
          <Button type="submit" variant="yolk">
            Continue with GitHub
          </Button>
        </form>
      ) : (
        <p className="egghead-empty-state">
          GitHub sign-in is not configured for this environment.
        </p>
      )}
    </>
  );
}

export default function LoginPage() {
  const runtime = getEggheadRuntime();
  const githubAuthConfigured = isGithubAuthConfigured();

  if (runtime === "production") notFound();

  return (
    <Container as="main" size="narrow">
      <Suspense
        fallback={
          <SectionHeader
            description="Checking your current session."
            eyebrow="Account"
            title="Loading your account…"
          />
        }
      >
        <AccountState githubAuthConfigured={githubAuthConfigured} />
      </Suspense>
    </Container>
  );
}
