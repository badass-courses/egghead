"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@egghead/ui/button";

import { disconnectGithubAccount, type GithubDisconnectActionResult } from "./actions";

type GithubAccountControlProps = {
  connected: boolean;
  disconnectAllowed: boolean;
};

export function GithubAccountControl({ connected, disconnectAllowed }: GithubAccountControlProps) {
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
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-y border-border-soft py-4">
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
            aria-describedby="github-disconnect-note"
            disabled={!actionIsAllowed || isPending}
            onClick={disconnect}
            size="sm"
            variant="ghost"
          >
            {isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 min-h-10 text-xs text-muted-foreground" id="github-disconnect-note">
        {connectionIsVisible && !disconnectAllowed ? (
          <p>
            GitHub is currently the only sign-in method supported by Egghead, so it cannot be
            disconnected yet.
          </p>
        ) : null}
        {connectionIsVisible && disconnectAllowed && !result ? (
          <p>Disconnecting removes this GitHub identity from your Egghead account.</p>
        ) : null}
        {!connectionIsVisible && !result ? (
          <p>No GitHub identity is linked to this account.</p>
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
