# Subscription lifecycle seam

The writer remains local Docker only. Checkout and webhook ingestion additionally require a
Stripe test key. This change does not add production writer ownership, a data import, a new
customer access promise, a table migration, or a dependency.

## Ownership

- Stripe owns billing status, quantity, and the period end. Its adapter decodes one recurring
  subscription item, supports both period-field generations, and preserves the original
  checkout kind from `subscription_data.metadata.bulk` when available.
- `Subscription.fields.membershipState` owns membership kind, owner, current assignments,
  an optional owner-selected reduction, the billing observation, and its event cursor.
  The roster is bounded to 100 unique users. Billing suspension does not remove assignments.
- Entitlements are the access projection. The store locks the subscription, loads its current
  roster, and atomically updates that projection and the authoritative state. Both prior grant
  identity schemes are retired in favor of one subscription/beneficiary ID.
- Inngest owns durable delivery and retries. A missing local subscription or a broken execution
  throws; it is never recorded as a successfully ignored event. Duplicate or older observations
  leave the locked state untouched. Final cancellation cannot reactivate the same subscription.
- Billing ownership is read separately from access eligibility, so an unpaid or canceled owner
  can still open billing. Team beneficiaries do not receive another person's billing portal.

## Capacity reductions

Owners save the target capacity and retained members on `/team` before changing billing.
Saving a plan leaves current access intact. A matching billing observation applies the selection
atomically; removed members do not return after capacity increases. An unplanned external
reduction below the assigned roster pauses team access until the owner chooses retained members.
A team stays a team at one seat. The owner does not receive an implicit team seat.

The former grant-backed local data is adopted lazily under the same lock. Adoption reads at most
201 historical grant rows and refuses anything above 200 instead of silently truncating. It
recognizes explicit non-granting billing statuses for previously suspended grants. This is a local
compatibility adapter, not a production backfill or a reconstruction of ambiguous Rails history.

## Checks and remaining provider evidence

`pnpm subscription:behaviors` is part of `pnpm check`. It covers lifecycle histories, 4,000 generated
commands against an independent model, signed final-cancellation dispatch, transport failures,
blocked checkout, malformed billing, and Drizzle transaction/batching receipts. Boundary checks
reject caller-selected grant identity, caller-supplied seat billing facts, and Stripe/SQL checkout
orchestration in the Next pricing action.

The Drizzle receipt suite replaces only mysql2 I/O. A populated reconciliation with missing
memberships issues 10 statements for either 1 or 100 beneficiaries: lookup, begin, locked
subscription read, merchant/owner read, membership batch read, membership batch insert,
projection revocation, grant batch upsert, state update, commit. Local adoption adds one bounded
legacy read. Replays issue no mutations. Failed projection work rolls back and can retry.

The subscription primary key anchors serialization; merchant/customer primary keys anchor owner
reads, the entitlement `source_idx` anchors projection work, and `organizationId_idx` scopes the
membership read. The lookup through `Subscription.merchantSubscriptionId` needs native plan
verification and may require a supporting index before scaling. No index or EXPLAIN result is
claimed without evidence.

Both a billing-suspension violation and per-member membership inserts were planted: the lifecycle
and statement-budget tests failed, respectively, and passed after restoring the implementations.
The local Docker database was unavailable during the original implementation; startup and a
read-only health query were subsequently verified. Native MySQL locks,
concurrent claims, actual rollback behavior, query plans, and end-to-end Stripe/Inngest delivery
remain unverified by these offline receipts.
