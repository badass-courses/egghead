import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../../../coursebuilder/current-user";
import { commerceWritesAreAllowed } from "../../../../db/local-docker";
import { getTeamInviteDetails, getTeamMembershipForUser } from "../../../../subscriptions/team";
import {
  teamInviteMatchesEmail,
  verifyTeamInviteToken,
} from "../../../../subscriptions/team-invite-token";
import { acceptTeamInvite } from "../../actions";

export const metadata: Metadata = {
  title: "Team invitation | egghead",
  description: "Accept an invitation to an egghead team membership.",
};

type InviteSearchParams = {
  error?: string | string[];
  status?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function invitePath(token: string) {
  return `/team/invite/${encodeURIComponent(token)}`;
}

function TeamAdminContact({ email, name }: { email: string | null; name: string | null }) {
  if (!email && !name) return null;

  return (
    <div className="rounded-2xl border border-border-strong bg-well px-5 py-4 text-left shadow-well">
      <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">Team admin</p>
      <p className="mt-1 font-extrabold">{name?.trim() || "Team owner"}</p>
      {email ? (
        <a
          className="mt-0.5 block break-words text-sm font-semibold text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground"
          href={`mailto:${email}`}
        >
          {email}
        </a>
      ) : null}
    </div>
  );
}

function InviteMessage({
  description,
  ownerEmail = null,
  ownerName = null,
  title,
}: {
  description: string;
  ownerEmail?: string | null;
  ownerName?: string | null;
  title: string;
}) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <section className="mx-auto grid w-full max-w-[34rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 text-center shadow-card-deep sm:p-9">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-well text-3xl shadow-well">
          <span aria-hidden>✓</span>
        </div>
        <div>
          <p className="text-sm font-extrabold text-muted-foreground">Team invitation</p>
          <h1 className="mt-2 text-balance text-4xl font-black tracking-tight">{title}</h1>
          <p className="mt-3 text-pretty font-semibold text-muted-foreground">{description}</p>
        </div>
        <TeamAdminContact email={ownerEmail} name={ownerName} />
      </section>
    </Container>
  );
}

export default function TeamInvitePage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<InviteSearchParams>;
}) {
  return (
    <Suspense
      fallback={
        <InviteMessage
          description="Checking the invitation details."
          title="Loading your invitation"
        />
      }
    >
      <TeamInviteContent {...props} />
    </Suspense>
  );
}

async function TeamInviteContent({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<InviteSearchParams>;
}) {
  const [{ token }, resolvedSearchParams, currentUser] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
  ]);
  const payload = verifyTeamInviteToken(token);
  if (!payload) notFound();

  const [inviteDetails, currentMembership] = await Promise.all([
    getTeamInviteDetails(payload.subscriptionId),
    currentUser?.id ? getTeamMembershipForUser(currentUser.id) : null,
  ]);
  const status = firstParam(resolvedSearchParams.status);
  const error = firstParam(resolvedSearchParams.error);
  const alreadyClaimed = currentMembership?.subscriptionId === payload.subscriptionId;

  if (status === "claimed" || inviteDetails?.availableSeats === 0 || alreadyClaimed) {
    return (
      <InviteMessage
        description="This team seat has already been claimed. Reach out to the team owner for a new invitation."
        ownerEmail={inviteDetails?.ownerEmail ?? null}
        ownerName={inviteDetails?.ownerName ?? null}
        title="This invite was claimed"
      />
    );
  }

  if (!inviteDetails || error === "unavailable") {
    return (
      <InviteMessage
        description="Reach out to the team owner for a new invitation."
        title="This invite is no longer available"
      />
    );
  }

  const emailMatches = !currentUser?.id || teamInviteMatchesEmail(payload, currentUser.email ?? "");
  const callbackParams = new URLSearchParams({ callbackUrl: invitePath(token) });
  const writesAllowed = commerceWritesAreAllowed();

  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <section className="mx-auto grid w-full max-w-[34rem] gap-7 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 shadow-card-deep sm:p-9">
        <header className="grid gap-3 text-center">
          <p className="text-sm font-extrabold text-muted-foreground">Team invitation</p>
          <h1 className="text-balance text-4xl font-black tracking-tight">
            You’re invited to join an egghead team
          </h1>
          <p className="text-pretty font-semibold text-muted-foreground">
            Accept a seat on {inviteDetails.productName} and start learning with your team.
          </p>
        </header>

        <TeamAdminContact email={inviteDetails.ownerEmail} name={inviteDetails.ownerName} />

        {!emailMatches || error === "email-mismatch" ? (
          <p
            className="rounded-xl border border-rust bg-rust/10 px-4 py-3 text-sm font-extrabold text-rust"
            role="alert"
          >
            Sign in with the email address that received this invitation.
          </p>
        ) : null}

        {currentUser?.id ? (
          <form action={acceptTeamInvite} className="grid gap-3">
            <input name="token" type="hidden" value={token} />
            <Button className="w-full" disabled={!writesAllowed || !emailMatches} type="submit">
              Accept team invitation
            </Button>
          </form>
        ) : (
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
            href={`/login?${callbackParams.toString()}`}
          >
            Sign in to accept
          </Link>
        )}

        {!writesAllowed ? (
          <p className="text-center text-xs font-bold text-muted-foreground">
            Team invitations can only be accepted in local development during Phase 0.
          </p>
        ) : null}
      </section>
    </Container>
  );
}
