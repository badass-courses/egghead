"use client";

import { useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@egghead/ui/button";

import {
  connectGithubAccount,
  disconnectGithubAccount,
  type GithubDisconnectActionResult,
} from "./actions";

type GithubAccountControlProps = {
  connected: boolean;
  connectionAvailable: boolean;
  disconnectAllowed: boolean;
};

function ConnectGithubButton({ connectionAvailable }: { connectionAvailable: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button
      aria-describedby="github-connection-note"
      disabled={!connectionAvailable || pending}
      size="sm"
      type="submit"
      variant="ghost"
    >
      {pending ? "Connecting…" : "Connect to GitHub"}
    </Button>
  );
}

export function GithubAccountControl({
  connected,
  connectionAvailable,
  disconnectAllowed,
}: GithubAccountControlProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<GithubDisconnectActionResult | null>(null);
  const disconnected = result?.status === "disconnected" || result?.status === "missing";
  const connectionIsVisible = connected && !disconnected;
  const actionIsAllowed = connectionIsVisible && disconnectAllowed;

  function disconnect() {
    setResult(null);
    startTransition(async () => {
      try {
        const nextResult = await disconnectGithubAccount();
        setResult(nextResult);
        if (nextResult.status === "disconnected" || nextResult.status === "missing") {
          router.refresh();
        }
      } catch {
        setResult({ status: "error" });
      }
    });
  }

  return (
    <div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-strong bg-well p-4 shadow-well">
        <div>
          <p className="font-extrabold">GitHub</p>
          <p
            className={
              connectionIsVisible
                ? "mt-1 text-xs font-bold text-sage-foreground"
                : "mt-1 text-xs font-bold text-muted-foreground"
            }
          >
            {connectionIsVisible ? "Connected" : "Not connected"}
          </p>
        </div>

        {connectionIsVisible ? (
          <Button
            aria-describedby="github-connection-note"
            disabled={!actionIsAllowed || isPending}
            onClick={disconnect}
            size="sm"
            variant="ghost"
          >
            {isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : (
          <form action={connectGithubAccount}>
            <ConnectGithubButton connectionAvailable={connectionAvailable} />
          </form>
        )}
      </div>

      <div className="mt-3 min-h-10 text-xs text-muted-foreground" id="github-connection-note">
        {connectionIsVisible && !disconnectAllowed ? (
          <p>
            GitHub is currently the only sign-in method supported by egghead, so it cannot be
            disconnected yet.
          </p>
        ) : null}
        {connectionIsVisible && disconnectAllowed && !result ? (
          <p>Disconnecting removes this GitHub identity from your egghead account.</p>
        ) : null}
        {!connectionIsVisible && !result ? (
          <p>
            {connectionAvailable
              ? "Connect GitHub to use it as another way to sign in."
              : "GitHub connections are temporarily unavailable."}
          </p>
        ) : null}
        {result?.status === "disconnected" ? (
          <output className="font-extrabold text-sage-foreground">
            GitHub disconnected successfully.
          </output>
        ) : null}
        {result?.status === "missing" ? (
          <output>GitHub was already disconnected from this account.</output>
        ) : null}
        {result?.status === "last-sign-in-method" ? (
          <div className="font-extrabold text-rust" role="alert">
            GitHub cannot be disconnected because it is your only available sign-in method.
          </div>
        ) : null}
        {result?.status === "unauthorized" ? (
          <div className="font-extrabold text-rust" role="alert">
            Your session expired. Sign in again before changing connected accounts.
          </div>
        ) : null}
        {result?.status === "error" ? (
          <div className="font-extrabold text-rust" role="alert">
            GitHub could not be disconnected. Try again.
          </div>
        ) : null}
      </div>
    </div>
  );
}
