import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { isGithubAuthConfigured } from "../../coursebuilder/auth-config";
import { getCurrentUserFromRequest } from "../../coursebuilder/current-user";
import { getEggheadRuntime } from "../../db/local-docker";
import { signIn } from "../../server/auth";

async function CurrentLoginState() {
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/login", { headers: requestHeaders }),
  );

  if (!currentUser.user) return null;

  return (
    <div className="egghead-login-state">
      <p className="eyebrow">Signed in</p>
      <p>
        {currentUser.user.access.granted
          ? "Membership access active"
          : "No active membership access"}
      </p>
    </div>
  );
}

async function signInWithGithub() {
  "use server";

  await signIn("github", { redirectTo: "/" });
}

export default function LoginPage() {
  const runtime = getEggheadRuntime();
  const githubAuthConfigured = isGithubAuthConfigured();

  if (runtime === "production") notFound();

  return (
    <Container as="main" size="narrow">
      <SectionHeader
        description="Use your GitHub account to continue."
        eyebrow="Account"
        title="Sign in to egghead"
      />

      <Suspense fallback={null}>
        <CurrentLoginState />
      </Suspense>

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
    </Container>
  );
}
