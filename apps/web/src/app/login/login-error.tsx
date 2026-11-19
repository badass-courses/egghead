import { GITHUB_EMAIL_UNVERIFIED_ERROR } from "../../coursebuilder/github-provider";

export function loginErrorMessage(error: string | undefined) {
  if (error === "Verification") {
    return "That sign-in link is invalid, expired, or has already been used. Request a new link below.";
  }

  if (error === "OAuthAccountNotLinked") {
    return "That GitHub account is already connected to a different egghead account.";
  }

  if (error === GITHUB_EMAIL_UNVERIFIED_ERROR) {
    return "Your GitHub account has no verified email address. Verify your email on GitHub and try again, or sign in with an email link.";
  }

  if (error === "EmailSignin") {
    return "We couldn't send that sign-in link. Check the address and try again.";
  }

  return null;
}

export function LoginErrorAlert({ error }: { error: string | undefined }) {
  const message = loginErrorMessage(error);
  if (!message) return null;

  return (
    <p
      className="rounded-xl border border-rust/40 bg-rust/10 px-4 py-3 text-sm font-bold text-rust"
      role="alert"
    >
      {message}
    </p>
  );
}
