# Subscription paid-through boundary

Account-subscription projection uses `strictPaidThroughRule` (ADR-0008). Only `active` with a strictly future paid boundary grants. The organization and personal seat entitlements both store Rails `currentPeriodEnd` in the existing `egghead_Entitlement.expiresAt`. Cancel-at-period-end does not extend it. Teams also require the scoped member seat. Missing or invalid boundaries grant nothing. No dunning grace is added.

Stable ids and idempotency keys are unchanged. The first delta converts old indefinite grants with `entitlement_update`; subsequent renewals use `entitlement_extend`. Replaying either plan converges. The top-up keeps this field fresh while Rails owns billing. The existing held-user guard remains conservative: changing an indefinite organization entitlement to a finite boundary can fail that guard even with a future boundary. Do not bypass that failure without reviewing the held users.

## Read audit

- `src/access/evaluate.ts`: removed the Rails source exception from `ACCESS_ENTITLEMENT_ROWS_SQL` and removed its SQL parameter. Every live entitlement must have a null or strictly future expiry.
- `src/access/rails-access-shadow.ts`: removed the same expiry exception. The export side now evaluates the shared strict rule using the analysis clock.
- `src/support/readback.ts`: already filters null or strictly future expiry. No change needed.
- `src/subscriptions/team.ts` and `src/subscriptions/status.ts`: already filter expiry for current Stripe grants. No change needed.
- `src/subscriptions/legacy-adoption.ts`: reconstructs the period boundary from the existing expiry field; it is not an alternative content-access reader. No change needed.
- Feed access uses the shared evaluator. No separate Rails entitlement exception exists there.

Null expiry remains valid for lifetime, basic, course, staff and approved legacy/gift grants. This change does not rewrite their separate laws. Old account-subscription rows with null expiry must be converted or revoked by the delta; removing the read exception alone does not fix those rows.

## Stripe lifecycle after handover

There is no second paid-boundary column. `subscriptions/store.ts` already writes `SubscriptionState.currentPeriodEnd` to the same entitlement `expiresAt` and includes that column in its upsert. Its transaction updates that same expiry on retired rows too, including failure and cancellation, and restores stable per-beneficiary rows. Renewal moves the expiry, cancel-at-period-end retains the observed paid boundary, and final cancellation or payment failure removes beneficiaries rather than granting grace. Recovery restores the same ids.

`subscriptionBeneficiaries` now evaluates the shared strict rule, so `past_due`, `trialing`, and `unpaid` cannot produce grants even with a future period end. Assignments survive suspension for recovery. Command/invite availability remains a separate lifecycle concern; a roster assignment alone does not grant content access.

This does not move writer ownership. Existing ownership-marker checks, environment write blocks and the required cutover ordering remain intact. The delta owns Rails-sourced rows; Stripe lifecycle owns Stripe-sourced rows. Both projections use `expiresAt` for the paid-through boundary.

## Dry-run loss review

The receipt's `subscriptionBoundaryLoss` compares current target holders under the old Rails source bypass against the full simulated strict projection. It counts people, not duplicated organization and personal-seat rows. An alternative valid broad grant prevents a counted loss. Course-specific access remains intact but does not replace all-access membership.

Each losing holder is assigned one primary reason in the reported priority order: `status_past_due`, `status_trialing`, `status_unpaid`, `missing_boundary`, `boundary_passed`, `no_seat`, `subscription_missing`, `status_other`. The final two buckets make source omissions and unsupported statuses visible rather than guessing a boundary. Missing includes invalid timestamps. Each bucket includes up to five sorted Rails subscription ids, never emails or provider ids. Counts use the analysis clock; identity-only receipts still report the full proposed access change.

The Rails export now includes `unpaid` subscription facts as well as active, trialing and past_due. Without those facts, an old export can only classify a missing subscription as `subscription_missing`, not infer unpaid status from stale target metadata. Regenerate the export for the loss review.

The report is a forecast after the proposed delta, not a claim that toggling expiry reads alone will remove indefinite rows. Held rows remain in the simulation and may prevent a loss; inspect the existing hold and over-grant sections alongside this report.

No live target was contacted to implement this change. Before deployment or applying the projection, run the desk's reviewed dry run, take the loss counts and held-user findings to the cutover decision owner, and obtain the separate read-flip approval. Publishing the PR does not authorize deployment, a database write, a marker flip, or lifting the commerce block.

Rollback requires both the reviewed delta undo receipt and the corresponding application revision. Restoring old readers alone will not restore soft-deleted grants. Follow the existing guarded rollback flow; never invent a second boundary field.
