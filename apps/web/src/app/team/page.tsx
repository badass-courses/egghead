import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { getSiteUrl } from "../../coursebuilder/stripe-provider";
import { commerceWritesAreAllowed } from "../../db/local-docker";
import { getOwnedTeamSubscription } from "../../subscriptions/team";
import { createTeamInviteToken } from "../../subscriptions/team-invite-token";
import { claimTeamSeat, inviteTeamMember, removeTeamMember } from "./actions";
import { TeamInviteLink } from "./team-invite-link";

export const metadata: Metadata = {
  title: "Your team | egghead",
  description: "Assign and manage seats on your egghead team membership.",
};

type TeamSearchParams = {
  error?: string | string[];
  notice?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function teamErrorMessage(error: string | undefined) {
  if (error === "invalid-invite") return "Enter a valid teammate email address.";
  if (error === "invite-email-failed") return "We could not send that invitation. Try again.";
  if (error === "already-assigned") return "That person already has a seat on this team.";
  if (error === "team-full") return "Every team seat is currently assigned.";
  if (error) return "We could not update this team membership. Please try again.";
  return null;
}

function teamNoticeMessage(notice: string | undefined) {
  if (notice === "seat-claimed") return "Your seat is active. Welcome to the team.";
  if (notice === "seat-removed") return "The seat is available for someone new.";
  if (notice === "invite-sent") return "Invitation sent. The seat is claimed when they accept.";
  return null;
}

function memberInitial(name: string | null, email: string) {
  return (name?.trim() || email).charAt(0).toUpperCase();
}

function formatJoinDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function TeamLoadingState() {
  return (
    <Container as="main" className="content-center gap-y-0" size="narrow">
      <output
        aria-label="Loading your team"
        className="mx-auto grid w-full max-w-[38rem] gap-5 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 shadow-card-deep sm:p-9"
      >
        <span className="h-4 w-28 animate-pulse rounded-full bg-border-strong motion-reduce:animate-none" />
        <span className="h-12 w-full animate-pulse rounded-xl bg-well shadow-well motion-reduce:animate-none" />
        <span className="h-28 w-full animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none" />
        <span className="sr-only">Loading your team</span>
      </output>
    </Container>
  );
}

export default function TeamPage({ searchParams }: { searchParams: Promise<TeamSearchParams> }) {
  return (
    <Suspense fallback={<TeamLoadingState />}>
      <TeamContent searchParams={searchParams} />
    </Suspense>
  );
}

async function TeamContent({ searchParams }: { searchParams: Promise<TeamSearchParams> }) {
  const [currentUser, resolvedSearchParams] = await Promise.all([getCurrentUser(), searchParams]);
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const team = await getOwnedTeamSubscription(currentUser.id);
  const writesAllowed = commerceWritesAreAllowed();
  const errorMessage = teamErrorMessage(firstParam(resolvedSearchParams.error));
  const noticeMessage = teamNoticeMessage(firstParam(resolvedSearchParams.notice));

  if (!team) {
    return (
      <Container as="main" className="content-center gap-y-0" size="narrow">
        <section className="mx-auto grid w-full max-w-[38rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 text-center shadow-card-deep sm:p-9">
          <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-well text-3xl shadow-well">
            <span aria-hidden>+</span>
          </div>
          <div>
            <p className="text-sm font-extrabold text-muted-foreground">Team learning</p>
            <h1 className="mt-2 text-balance text-4xl font-black tracking-tight">
              Bring the whole crew.
            </h1>
            <p className="mt-3 text-pretty font-semibold text-muted-foreground">
              Purchase two or more seats together, then invite teammates from one simple roster.
            </p>
          </div>
          <Link
            className="press inline-flex items-center justify-center rounded-full border border-yolk-shadow/40 bg-yolk-grad px-9 pt-[17px] pb-[15px] text-lg font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
            href="/pricing"
          >
            View team plans
          </Link>
        </section>
      </Container>
    );
  }

  const inviteToken = createTeamInviteToken(team.id);
  const inviteUrl = new URL(`/team/invite/${inviteToken}`, getSiteUrl()).toString();

  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <header className="overflow-hidden rounded-[1.75rem] border border-border-strong bg-surface-grad shadow-card-deep">
          <div className="grid gap-7 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
            <div>
              <p className="text-sm font-extrabold text-muted-foreground">Team membership</p>
              <h1 className="mt-2 text-balance text-4xl font-black tracking-tight sm:text-5xl">
                Learning works better together.
              </h1>
              <p className="mt-3 max-w-2xl text-pretty font-semibold text-muted-foreground">
                Assign seats for {team.productName}. Every teammate gets their own progress,
                history, and full-library access.
              </p>
            </div>
            <div className="rounded-2xl bg-well p-5 shadow-well">
              <div className="flex items-end justify-between gap-4">
                <p className="text-sm font-extrabold text-muted-foreground">Seats in use</p>
                <p className="text-3xl font-black tabular-nums">
                  {team.usedSeats}
                  <span className="text-lg text-muted-foreground">/{team.totalSeats}</span>
                </p>
              </div>
              <progress
                aria-label={`${team.usedSeats} of ${team.totalSeats} seats assigned`}
                className="mt-4 block h-3 w-full overflow-hidden rounded-full bg-surface shadow-inner [&::-moz-progress-bar]:bg-yolk [&::-webkit-progress-bar]:bg-surface [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-yolk"
                max={team.totalSeats}
                value={team.usedSeats}
              />
              <p className="mt-3 text-xs font-bold text-muted-foreground">
                {team.availableSeats === 1
                  ? "1 seat ready to assign"
                  : `${team.availableSeats} seats ready to assign`}
              </p>
            </div>
          </div>
        </header>

        {errorMessage ? (
          <div
            className="rounded-xl border border-rust bg-rust/10 px-4 py-3 text-sm font-extrabold text-rust"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}
        {noticeMessage ? (
          <output className="rounded-xl border border-sage-line bg-sage-wash px-4 py-3 text-sm font-extrabold text-sage-foreground">
            {noticeMessage}
          </output>
        ) : null}

        {!writesAllowed ? (
          <p className="rounded-xl border border-border-strong bg-well px-4 py-3 text-sm font-bold text-muted-foreground shadow-well">
            Team changes are limited to local Docker during Phase 0.
          </p>
        ) : null}

        {!team.ownerHasSeat ? (
          <section className="grid gap-5 rounded-2xl border border-yolk-shadow/40 bg-yolk-grad p-5 text-yolk-foreground shadow-card sm:grid-cols-[1fr_auto] sm:items-center sm:p-6">
            <div>
              <h2 className="text-xl font-black">Claim a seat for yourself</h2>
              <p className="mt-1 text-sm font-semibold opacity-80">
                Team purchases keep every seat flexible, including yours.
              </p>
            </div>
            <form action={claimTeamSeat}>
              <input name="subscriptionId" type="hidden" value={team.id} />
              <Button disabled={!writesAllowed} type="submit" variant="navy">
                Claim my seat
              </Button>
            </form>
          </section>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.45fr)] lg:items-start">
          <section className="rounded-2xl border border-border-strong bg-surface-grad shadow-card">
            <div className="border-b border-border p-5 sm:p-6">
              <h2 className="text-2xl font-black tracking-tight">Your roster</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Assigned seats can sign in immediately with the email shown here.
              </p>
            </div>

            {team.members.length > 0 ? (
              <ul className="divide-y divide-border">
                {team.members.map((member) => (
                  <li className="flex items-center gap-4 p-4 sm:px-6" key={member.entitlementId}>
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border-strong bg-well font-black shadow-well">
                      {memberInitial(member.name, member.email)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-extrabold">{member.name || member.email}</p>
                        {member.isOwner ? (
                          <span className="rounded-full bg-sage-wash px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-sage-foreground">
                            Owner
                          </span>
                        ) : null}
                      </div>
                      {member.name ? (
                        <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                      ) : null}
                      <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                        Joined {formatJoinDate(member.joinedAt)}
                      </p>
                    </div>
                    {!member.isOwner ? (
                      <form action={removeTeamMember}>
                        <input name="subscriptionId" type="hidden" value={team.id} />
                        <input name="userId" type="hidden" value={member.userId} />
                        <Button disabled={!writesAllowed} size="sm" type="submit" variant="ghost">
                          Remove
                        </Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-6 text-sm font-semibold text-muted-foreground">
                No seats are assigned yet. Claim yours or invite a teammate to get started.
              </p>
            )}
          </section>

          <aside className="grid content-start gap-6">
            <section className="rounded-2xl border border-border-strong bg-surface-grad p-5 shadow-card sm:p-6">
              <h2 className="text-xl font-black">Invite teammates</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Share this link. Each person signs in and accepts their own seat.
              </p>
              <TeamInviteLink
                disabled={!writesAllowed || team.availableSeats === 0}
                url={inviteUrl}
              />

              <form
                action={inviteTeamMember}
                className="mt-5 grid gap-3 border-t border-border pt-5"
              >
                <input name="subscriptionId" type="hidden" value={team.id} />
                <label className="grid gap-1.5" htmlFor="team-email">
                  <span className="text-sm font-extrabold">Send to a specific email</span>
                  <input
                    aria-label="Teammate email address"
                    autoComplete="email"
                    className="h-12 rounded-xl border border-border-strong bg-well px-4 text-sm font-semibold shadow-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    disabled={!writesAllowed || team.availableSeats === 0}
                    id="team-email"
                    name="email"
                    placeholder="teammate@company.com"
                    required
                    type="email"
                  />
                </label>
                <Button
                  className="w-full"
                  disabled={!writesAllowed || team.availableSeats === 0}
                  type="submit"
                  variant="ghost"
                >
                  {team.availableSeats === 0 ? "Team is full" : "Email invite link"}
                </Button>
              </form>

              {team.availableSeats === 0 ? (
                <p className="mt-3 text-xs font-bold text-rust">
                  Your team is full. Remove a teammate before sending another invite.
                </p>
              ) : null}
            </section>
          </aside>
        </div>
      </Container>
    </main>
  );
}
