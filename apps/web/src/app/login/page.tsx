import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";
import { z } from "zod";

import { isEmailAuthConfigured, isGithubAuthConfigured } from "../../coursebuilder/auth-config";
import { getCurrentUserFromRequest } from "../../coursebuilder/current-user";
import { getEggheadRuntime } from "../../db/local-docker";
import { signIn, signOut } from "../../server/auth";

type LoginSearchParams = {
  callbackUrl?: string | string[];
  error?: string | string[];
};

const authPanelClassName =
  "mx-auto grid w-full max-w-[30rem] gap-7 rounded-[1.75rem] border border-border-strong bg-surface-grad p-5 shadow-card-deep sm:p-8";

function GithubIcon() {
  return (
    <svg aria-hidden fill="currentColor" height="20" viewBox="0 0 24 24" width="20">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.9c.85 0 1.71.12 2.51.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.04 10.04 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function AuthHeader({
  description,
  eyebrow,
  title,
}: {
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className="grid gap-2.5">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="text-balance text-3xl font-black tracking-tight" id="auth-title">
        {title}
      </h1>
      <p className="max-w-[42ch] text-pretty text-base text-muted-foreground">{description}</p>
    </header>
  );
}

function LoginLoadingState() {
  return (
    <section aria-busy="true" aria-labelledby="auth-loading-title" className={authPanelClassName}>
      <h1 className="sr-only" id="auth-loading-title">
        Checking your session
      </h1>
      <div aria-hidden className="grid animate-pulse gap-3 motion-reduce:animate-none">
        <span className="h-3 w-24 rounded-full bg-well" />
        <span className="h-9 w-3/4 rounded-xl bg-well" />
        <span className="h-5 w-full rounded-lg bg-well" />
      </div>
      <div aria-hidden className="grid animate-pulse gap-4 motion-reduce:animate-none">
        <span className="h-4 w-28 rounded-full bg-well" />
        <span className="h-13 w-full rounded-xl bg-well" />
        <span className="h-13 w-full rounded-xl bg-well" />
      </div>
    </section>
  );
}

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeCallbackPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  try {
    const url = new URL(value, "http://egghead.local");

    if (url.origin !== "http://egghead.local") return "/";

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function loginErrorMessage(error: string | undefined) {
  if (error === "Verification") {
    return "That sign-in link is invalid, expired, or has already been used. Request a new link below.";
  }

  if (error === "EmailSignin") {
    return "We couldn't send that sign-in link. Check the address and try again.";
  }

  return null;
}

async function signInWithGithub() {
  "use server";

  await signIn("github", { redirectTo: "/" });
}

async function signInWithEmail(callbackUrl: string, formData: FormData) {
  "use server";

  const emailValue = formData.get("email");
  const returnPath = safeCallbackPath(callbackUrl);
  const email = z
    .email()
    .safeParse(typeof emailValue === "string" ? emailValue.trim() : emailValue);

  if (!email.success) {
    const searchParams = new URLSearchParams({
      callbackUrl: returnPath,
      error: "EmailSignin",
    });
    redirect(`/login?${searchParams.toString()}`);
  }

  const signInForm = new FormData();
  signInForm.set("email", email.data);
  signInForm.set("redirectTo", returnPath);

  await signIn("postmark", signInForm);
}

async function signOutOfEgghead() {
  "use server";

  await signOut({ redirectTo: "/" });
}

async function AccountState({
  callbackUrl,
  emailAuthConfigured,
  error,
  githubAuthConfigured,
}: {
  callbackUrl: string;
  emailAuthConfigured: boolean;
  error: string | undefined;
  githubAuthConfigured: boolean;
}) {
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/login", { headers: requestHeaders }),
  );

  if (currentUser.user) {
    return (
      <section aria-labelledby="auth-title" className={authPanelClassName}>
        <AuthHeader
          description={
            currentUser.user.access.granted
              ? "Your membership access is active and ready to use."
              : "This account is signed in without active membership access."
          }
          eyebrow="Account ready"
          title="You're signed in"
        />

        <form action={signOutOfEgghead}>
          <Button className="w-full" type="submit" variant="ghost">
            Sign out
          </Button>
        </form>
      </section>
    );
  }

  const errorMessage = loginErrorMessage(error);
  const signInWithEmailAndCallback = signInWithEmail.bind(null, callbackUrl);
  const description =
    emailAuthConfigured && githubAuthConfigured
      ? "Use a secure email link, or continue with GitHub."
      : emailAuthConfigured
        ? "No password needed. We'll email you a secure sign-in link."
        : githubAuthConfigured
          ? "Use your GitHub account to continue."
          : "Sign-in is temporarily unavailable.";

  return (
    <section aria-labelledby="auth-title" className={authPanelClassName}>
      <AuthHeader description={description} eyebrow="Welcome back" title="Sign in to egghead" />

      {errorMessage ? (
        <p
          className="rounded-xl border border-rust/40 bg-rust/10 px-4 py-3 text-sm font-bold text-rust"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {emailAuthConfigured ? (
        <form action={signInWithEmailAndCallback} className="grid gap-4">
          <label className="grid gap-2 text-sm font-extrabold" htmlFor="email">
            Email address
            <input
              aria-label="Email address"
              autoComplete="email"
              className="min-h-13 rounded-xl border border-border-strong bg-well px-4 py-3 text-base font-semibold text-foreground shadow-well outline-none placeholder:font-semibold placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              id="email"
              inputMode="email"
              name="email"
              placeholder="you@example.com"
              required
              spellCheck={false}
              type="email"
            />
          </label>
          <Button className="w-full" type="submit" variant="yolk">
            Send my sign-in link
          </Button>
        </form>
      ) : null}

      {emailAuthConfigured && githubAuthConfigured ? (
        <div
          aria-hidden
          className="flex items-center gap-3 text-xs font-extrabold text-muted-foreground"
        >
          <span className="h-px flex-1 bg-border-strong" />
          <span>OR</span>
          <span className="h-px flex-1 bg-border-strong" />
        </div>
      ) : null}

      {githubAuthConfigured ? (
        <form action={signInWithGithub}>
          <Button className="w-full" type="submit" variant="ghost">
            <GithubIcon />
            Continue with GitHub
          </Button>
        </form>
      ) : null}

      {!emailAuthConfigured && !githubAuthConfigured ? (
        <p className="egghead-empty-state">Please try again later.</p>
      ) : null}
    </section>
  );
}

async function ResolvedAccountState({
  searchParams,
}: {
  searchParams: Promise<LoginSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const callbackUrl = safeCallbackPath(firstSearchParam(resolvedSearchParams.callbackUrl));
  const emailAuthConfigured = isEmailAuthConfigured();
  const githubAuthConfigured = isGithubAuthConfigured();
  const error = firstSearchParam(resolvedSearchParams.error);

  return (
    <AccountState
      callbackUrl={callbackUrl}
      emailAuthConfigured={emailAuthConfigured}
      error={error}
      githubAuthConfigured={githubAuthConfigured}
    />
  );
}

export default function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  const runtime = getEggheadRuntime();

  if (runtime === "production") notFound();

  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense fallback={<LoginLoadingState />}>
        <ResolvedAccountState searchParams={searchParams} />
      </Suspense>
    </Container>
  );
}
