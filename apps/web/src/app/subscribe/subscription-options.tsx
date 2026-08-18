"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@egghead/ui/button";

import type { BillingInterval } from "@coursebuilder/core/schemas";

import { subscriptionIntervalLabel } from "../../subscriptions/options";
import { startSubscriptionCheckout } from "./actions";

export type SubscriptionOption = {
  productId: string;
  name: string;
  description: string | null;
  price: string;
  billingInterval: NonNullable<BillingInterval>;
};

type SubscriptionOptionsProps = {
  checkoutAvailable: boolean;
  commerceWritesAllowed: boolean;
  configured: boolean;
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
  options,
  signedIn,
}: SubscriptionOptionsProps) {
  const [selectedProductId, setSelectedProductId] = useState(() => options.at(0)?.productId ?? "");
  const selectedOption =
    options.find((option) => option.productId === selectedProductId) ?? options.at(0);

  if (!selectedOption) return null;

  const intervalLabel = subscriptionIntervalLabel(selectedOption.billingInterval);
  const membershipName = options.at(0)?.name ?? selectedOption.name;

  return (
    <article className="overflow-hidden rounded-2xl bg-well shadow-well">
      <div className="grid gap-6 bg-surface-grad p-6 text-center sm:p-8">
        <div className="grid gap-2">
          <h2 className="text-balance text-2xl font-black tracking-tight">{membershipName}</h2>
          <p className="text-sm font-semibold text-muted-foreground">
            {selectedOption.description ?? "Unlimited learning for one egghead account."}
          </p>
        </div>

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
              {selectedOption.price}
            </span>
            <span className="mb-2 text-lg font-extrabold text-muted-foreground">
              /{selectedOption.billingInterval}
            </span>
          </p>
          <p className="text-xs font-bold text-muted-foreground">
            Billed every {selectedOption.billingInterval}. Cancel anytime.
          </p>
        </div>

        {signedIn ? (
          <form action={startSubscriptionCheckout} className="grid gap-3">
            <input name="productId" type="hidden" value={selectedOption.productId} />
            <Button className="w-full" disabled={!checkoutAvailable} size="lg" type="submit">
              Subscribe {intervalLabel.toLowerCase()}
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
            Progress saved to your egghead account
          </li>
        </ul>
      </div>
    </article>
  );
}
