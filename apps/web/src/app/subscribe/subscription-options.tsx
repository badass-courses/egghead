"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@egghead/ui/button";

import type { BillingInterval } from "@coursebuilder/core/schemas";

import { subscriptionIntervalLabel } from "../../subscriptions/options";
import { MAX_TEAM_SEATS, MIN_TEAM_SEATS } from "../../subscriptions/team-contracts";
import { startSubscriptionCheckout } from "./actions";

export type SubscriptionOption = {
  productId: string;
  name: string;
  description: string | null;
  currency: string;
  price: string;
  unitAmount: number;
  billingInterval: NonNullable<BillingInterval>;
};

type SubscriptionOptionsProps = {
  checkoutAvailable: boolean;
  commerceWritesAllowed: boolean;
  configured: boolean;
  defaultTeamPurchase: boolean;
  options: SubscriptionOption[];
  signedIn: boolean;
};

function IncludedIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 size-5 shrink-0 text-sage-foreground"
      fill="none"
      viewBox="0 0 20 20"
    >
      <path
        d="m4.5 10.25 3.25 3.25 7.75-8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.25"
      />
    </svg>
  );
}

export function SubscriptionOptions({
  checkoutAvailable,
  commerceWritesAllowed,
  configured,
  defaultTeamPurchase,
  options,
  signedIn,
}: SubscriptionOptionsProps) {
  const [selectedProductId, setSelectedProductId] = useState(() => options.at(0)?.productId ?? "");
  const [teamPurchase, setTeamPurchase] = useState(defaultTeamPurchase);
  const [teamSeats, setTeamSeats] = useState(5);
  const selectedOption =
    options.find((option) => option.productId === selectedProductId) ?? options.at(0);

  if (!selectedOption) return null;

  const intervalLabel = subscriptionIntervalLabel(selectedOption.billingInterval);
  const membershipName = options.at(0)?.name ?? selectedOption.name;
  const quantity = teamPurchase ? teamSeats : 1;
  const totalPrice = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: selectedOption.currency,
    maximumFractionDigits: Number.isInteger(selectedOption.unitAmount) ? 0 : 2,
  }).format(selectedOption.unitAmount * quantity);

  return (
    <article className="overflow-hidden rounded-2xl bg-well shadow-well">
      <div className="grid gap-6 bg-surface-grad p-6 text-center sm:p-8">
        <div className="grid gap-2">
          <h2 className="text-balance text-2xl font-black tracking-tight">{membershipName}</h2>
          <p className="text-sm font-semibold text-muted-foreground">
            {teamPurchase
              ? `Full egghead access for ${teamSeats} people, managed from one account.`
              : (selectedOption.description ?? "Unlimited learning for one egghead account.")}
          </p>
        </div>

        <fieldset className="mx-auto grid w-full max-w-[24rem] gap-2">
          <legend className="sr-only">Choose who the membership is for</legend>
          <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-well p-1.5 shadow-well">
            {[
              { label: "Just me", team: false },
              { label: "My team", team: true },
            ].map((choice) => (
              <label className="relative cursor-pointer" key={choice.label}>
                <input
                  aria-label={choice.label}
                  checked={teamPurchase === choice.team}
                  className="peer sr-only"
                  name="purchaseKindPreview"
                  onChange={() => setTeamPurchase(choice.team)}
                  type="radio"
                />
                <span className="press flex min-h-12 items-center justify-center rounded-xl px-4 py-2 font-extrabold text-muted-foreground transition-[background-color,color,box-shadow] peer-checked:bg-surface-grad peer-checked:text-foreground peer-checked:shadow-btn-ghost peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                  {choice.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {teamPurchase ? (
          <div className="mx-auto grid w-full max-w-[24rem] grid-cols-[1fr_auto] items-end gap-4 rounded-2xl border border-border-strong bg-surface-grad p-4 text-left shadow-btn-ghost">
            <label className="grid gap-1.5" htmlFor="team-seats">
              <span className="text-sm font-extrabold">Team seats</span>
              <span className="text-xs font-semibold text-muted-foreground">
                You can invite teammates after checkout.
              </span>
            </label>
            <input
              aria-label="Team seats"
              className="h-12 w-24 rounded-xl border border-border-strong bg-well px-3 text-center text-lg font-black tabular-nums shadow-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              id="team-seats"
              max={MAX_TEAM_SEATS}
              min={MIN_TEAM_SEATS}
              onChange={(event) => {
                const nextSeats = event.currentTarget.valueAsNumber;
                if (Number.isInteger(nextSeats)) {
                  setTeamSeats(Math.min(MAX_TEAM_SEATS, Math.max(MIN_TEAM_SEATS, nextSeats)));
                }
              }}
              type="number"
              value={teamSeats}
            />
          </div>
        ) : null}

        {options.length > 1 ? (
          <fieldset className="mx-auto grid w-full max-w-[24rem] gap-2">
            <legend className="sr-only">Choose a billing interval</legend>
            <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-well p-1.5 shadow-well">
              {options.map((option) => {
                const label = subscriptionIntervalLabel(option.billingInterval);

                return (
                  <label className="relative cursor-pointer" key={option.productId}>
                    <input
                      aria-label={label}
                      checked={option.productId === selectedOption.productId}
                      className="peer sr-only"
                      name="billingIntervalPreview"
                      onChange={() => setSelectedProductId(option.productId)}
                      type="radio"
                      value={option.productId}
                    />
                    <span className="press flex min-h-12 items-center justify-center rounded-xl px-4 py-2 font-extrabold text-muted-foreground transition-[background-color,color,box-shadow] peer-checked:bg-surface-grad peer-checked:text-foreground peer-checked:shadow-btn-ghost peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                      {label}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <div aria-live="polite" className="grid min-h-24 content-center gap-1">
          <p
            aria-label={`${selectedOption.price} per ${selectedOption.billingInterval}`}
            className="flex items-end justify-center gap-1"
          >
            <span className="mb-7 text-sm font-extrabold text-muted-foreground">US</span>
            <span className="text-5xl font-black tracking-tight tabular-nums sm:text-6xl">
              {teamPurchase ? totalPrice : selectedOption.price}
            </span>
            <span className="mb-2 text-lg font-extrabold text-muted-foreground">
              /{selectedOption.billingInterval}
            </span>
          </p>
          <p className="text-xs font-bold text-muted-foreground">
            {teamPurchase ? `${selectedOption.price} per seat. ` : ""}Billed every{" "}
            {selectedOption.billingInterval}. Cancel anytime.
          </p>
        </div>

        {signedIn ? (
          <form action={startSubscriptionCheckout} className="grid gap-3">
            <input name="productId" type="hidden" value={selectedOption.productId} />
            <input name="quantity" type="hidden" value={quantity} />
            <Button className="w-full" disabled={!checkoutAvailable} size="lg" type="submit">
              {teamPurchase
                ? `Subscribe for ${teamSeats} seats`
                : `Subscribe ${intervalLabel.toLowerCase()}`}
            </Button>
            {!commerceWritesAllowed ? (
              <p className="text-xs font-semibold text-muted-foreground">
                Checkout is limited to local Docker during Phase 0.
              </p>
            ) : configured ? null : (
              <p className="text-xs font-semibold text-muted-foreground">
                Subscription checkout is not configured yet.
              </p>
            )}
          </form>
        ) : (
          <Link
            className="press inline-flex items-center justify-center rounded-full border border-yolk-shadow/40 bg-yolk-grad px-9 pt-[17px] pb-[15px] text-lg font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
            href="/login?callbackUrl=/subscribe"
          >
            Sign in to subscribe
          </Link>
        )}
      </div>

      <div className="grid gap-4 p-6 sm:p-8">
        <p className="font-extrabold">Every membership includes</p>
        <ul className="grid gap-3 font-bold">
          <li className="flex gap-3">
            <IncludedIcon />
            Full course and lesson access
          </li>
          <li className="flex gap-3">
            <IncludedIcon />
            New material as it ships
          </li>
          <li className="flex gap-3">
            <IncludedIcon />
            {teamPurchase
              ? "A private learning profile for every teammate"
              : "Progress saved to your egghead account"}
          </li>
          {teamPurchase ? (
            <li className="flex gap-3">
              <IncludedIcon />
              Invite, remove, and reassign seats anytime
            </li>
          ) : null}
        </ul>
      </div>
    </article>
  );
}
