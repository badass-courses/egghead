# Paid-access delta (Rails to CourseBuilder)

`pnpm access:delta` re-projects who has paid access from a Rails export into CourseBuilder. It replaces the one-shot July 2026 projection with a delta you can rehearse now and rerun at the flip.

Law: **ADR-0006, lenient at the flip.** Anyone Rails grants today keeps access. A subscription in `trialing`, `active` or `past_due` grants, whatever its period end says.

ADR-0006 note: grants follow Rails `is_pro?` today. Live legacy backing (an active gift, managed subscription or legacy subscription) only explains a grant and sets its expiry; it never widens it. Bare `pro` with no backing is granted only to users active in the last year. Rails' own sign-in check would strip the others the next time they log in.

## Pieces

| File                                              | Role                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/sql/rails-access-export.sql`             | Read-only Postgres export, run by the desk on Rails. Emits JSONL.                         |
| `scripts/sql/rails-access-coverage.sql`           | Read-only Rails counts for legacy paths the export does not cover. Aggregates only.       |
| `apps/web/src/access/rails-access-delta.ts`       | Pure: parse and verify the export, resolve identity, build expected rows, diff, simulate. |
| `apps/web/src/access/rails-access-shadow.ts`      | Pure: "Rails says X, CourseBuilder says Y" per user.                                      |
| `apps/web/src/access/rails-access-delta-store.ts` | CourseBuilder reads and idempotent writes through the app's Drizzle database.             |
| `apps/web/src/access/rails-access-delta-plan.ts`  | Plan and cursor files for apply and resume.                                               |
| `scripts/access-delta-run.ts`                     | Analysis, receipt, apply preconditions and verification shared by the CLI and tests.      |
| `scripts/access-delta.ts`                         | CLI.                                                                                      |
| `scripts/access-delta.test.ts`                    | Pure tests plus the MySQL fixture suite.                                                  |

## Desk commands

The export needs a Rails read connection, and the dry run needs a CourseBuilder read connection. Neither prints secrets. Keep every output folder in a private directory outside any git work tree (`$WORK` below). The tool refuses an `--out` inside a work tree and sets every `--out` to mode 0700, including existing folders. Without `--out`, a dry run writes to a new folder under `$XDG_STATE_HOME/egghead-access-delta` (default `~/.local/state`). `plan.json` holds customer emails and names; it must never leave that directory.

1. Count the legacy backing paths (once per rehearsal; aggregates only):

   ```sh
   psql "$RAILS_DATABASE_URL" -X -q -A -v ON_ERROR_STOP=1 -f scripts/sql/rails-access-coverage.sql
   ```

   Each row is a path (active gifts, active gifts without an account subscription, active managed-subscription members, active legacy subscriptions) with its user count and how many of those users still hold `pro`. Only backing for users Rails grants as pro is exported and granted; the rest is counted in the manifest (`backedWithoutPro`). The coverage SQL counts users and the receipt counts rows, so a user with two legacy subscriptions counts once there and twice in `backingGrants.bySourceType`.

2. Export from Rails (Postgres; a read replica is fine). The SQL pins the session to UTC and opens a `READ ONLY` repeatable-read transaction:

   ```sh
   psql "$RAILS_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f scripts/sql/rails-access-export.sql -o "$WORK/rails-access-export.jsonl"
   tail -1 "$WORK/rails-access-export.jsonl"   # the manifest line
   ```

3. Dry run against beta. It is read-only, and the beta guard needs `EGGHEAD_BETA_DB_APPROVED=true` and the PlanetScale URL (inject it with agent-secrets rather than exporting it):

   ```sh
   EGGHEAD_RUNTIME=beta EGGHEAD_BETA_DB_APPROVED=true DATABASE_URL="$BETA_DATABASE_URL" \
     pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/beta-dry-run" \
       [--previous-receipt "$WORK/<last run>/receipt.json"]
   ```

   `--previous-receipt` must be a receipt of this format, from a strictly earlier export, for the same target (runtime, database, host and user), with a passing gate.

   The analysis clock is the export's `exportedAt`, the moment Rails decided what had expired. `--now <iso>` overrides it for a dry run; `--apply` and `--resume` refuse `--now`, so a write always uses the export's clock.

   On beta and production, CourseBuilder is read query by query: PlanetScale caps transaction time, and a full read of every entitlement and membership does not fit in one transaction. A read that straddles a write can only produce a plan that a fresh read disagrees with, and `--apply` refuses that. On the local runtime the read runs in one `REPEATABLE READ, READ ONLY` transaction. `--snapshot-transaction` and `--no-snapshot-transaction` override the default; the receipt records which ran (`snapshotTransaction`).

   Granted rows per gated source type (`rails_gift`, `rails_managed_subscription`, `rails_legacy_subscription`, `rails_bare_pro_active`) need a check against something. With `--previous-receipt`, a type that more than doubles since that run fails the gate until `--allow-backing-growth`. Without one (a first run), every type above zero needs `--accept-first-backing <sourceType>=<count>`, and the count must equal what the plan grants.

   Ask about one learner with `--user`, repeated as needed. It accepts a Rails user id, a CourseBuilder user id or an email, and prints one JSON line with `railsSays`, `cbSays` and a verdict, both now and after the simulated apply.

4. Read `<out>/receipt.json`. Before trusting the total, read `changes.reasons`: a reason that covers nearly every row means the real July rows differ from what the delta expects. The flip gate is `gate.pass`, and `changes.planSha256` names the plan you reviewed. The gate fails when, after the simulated apply:
   - any Rails-granted user is still under-granted, including unresolved identities;
   - any user is over-granted from Rails rows. An over-grant is accepted only when every owned row behind it is one a hold keeps (a held stale legacy subscription, a held bare or stale-only holder) or reaches the user through a seat ruled `keep`. A second, unruled seat for the same user still fails;
   - the plan does not converge;
   - there are identity conflicts (`identityConflicts`): Rails emails the column collation treats as one, emails owned by another Rails user, or held email updates. If the plan has `user_email_update` or `user_link` ops, run the identity pass (step 5) first;
   - there are held bare `pro` holders (`proCrossCheck.bareProHolders`): Rails holds `pro`, and nothing else grants the user (no special role, `basic`, member seat, membership purchase or live backing), and they did not sign in within `--bare-pro-active-days` (default 365) of the export. Recently active ones are granted instead (`bareProActive`). The receipt lists every held id, a `sample` of 20 spread across the list, and `bareProSignIn` buckets. Accepting means no new grant for the held ones; their existing rows and seats are kept. Once a person has ruled, pass `--accept-bare-pro <bareProHolders.sha256>`. The sha covers the exact set, so a changed list fails again even at the same size;
   - there are held stale legacy subscriptions (`heldLegacySubscriptions`): a pro holder's legacy subscription whose `currentPeriodEnd` is more than `--legacy-stale-days` (default 45) before the export, or missing, because Stripe stopped renewing it without a cancel. A holder whose only backing is such a subscription is bare `pro` with dead billing, so the same sign-in window decides: inside `--bare-pro-active-days` they get `rails_bare_pro_active` (counted in `grantedInWindow` and the first-backing count); outside it the subscription is held. A holder granted another way is on no list, and a stale-only holder is never also on the bare list. `holderSignIn` buckets every stale-only holder. Accepting means no new grant; existing rows are kept. Accept the held set with `--accept-stale-legacy <heldLegacySubscriptions.sha256>`;
   - there are held managed subscriptions (`heldManagedSubscriptions`): managed-only holders without a current paid-through legacy subscription. Accept the exact managed-subscription/user pairs with `--accept-stale-managed <heldManagedSubscriptions.sha256>`. Acceptance grants nothing, creates no user and keeps existing access. Another independent source can still grant a holder; those are not managed-only holds;
   - any op takes something from a held user (`revokesOnHeldUsers.ops`; must read 0). The receipt joins revokes, expiries, seat-flag clears, an `entitlement_update` that moves a row to another user or organization or brings its expiry forward, and a `membership_update` that moves a seat, to the Rails ids they reach: through the row's `railsUserId`, its linked user, or, for an organization row, every member whose seat flag grants. An op whose row is not in the snapshot counts in `missingTargets`, which must also read 0. Either count above 0 is a bug: do not apply;
   - there are orphan grants (`orphanGrants`): grant lines for a Rails user with no user line. Their rows are revoked (below), so look first: an export that dropped user lines would read as paying users deleted. Accept with `--accept-orphan-grants <orphanGrants.sha256>`;
   - non-held users keep all access only through an organization row held for a held member's seat (`heldOrganizationReach`: over-granted after the simulated apply through that row). Rule on them, then pass `--accept-held-org-reach <heldOrganizationReach.sha256>`;
   - a first run has a granted source type without a matching `--accept-first-backing`;
   - a held seat flag (`heldSeatFlags`) has no ruling. A seat flag on an organization with CourseBuilder-native grants (a Stripe team) is held because clearing it also cuts the native grant. Rule on each by membership id with `--held-seat-flag <membershipId>=clear` (revoke the seat; the member loses the native grant too) or `=keep` (leave it; that member's over-grant is accepted). A held seat keeps its flag and the role it implies; every other change Rails made to the membership still applies. A ruling for a membership that is not held fails the gate;
   - a gated source type more than doubled since `--previous-receipt` without `--allow-backing-growth`;
   - identity ops (`user_email_update` plus `user_link`) exceed `--max-identity-ops` (default 50), or any identity write collides: two writes onto one email, a write onto an email another user holds, or conflicting links (`identityOps`). Both passes check this;
   - the shadow summary disagrees with its user list (a guard against a truncated compare);
   - revokes and access moves trip the alarm without `--allow-large-revoke`. The alarm counts entitlement revokes, seat-flag clears (`membership_revoke` and a `membership_update` that clears the seat), `entitlement_update` ops that move a row to another user, type or organization, and expiries of subscription rows.

   `proCrossCheck.exportHasRailsLacks` (the export grants all access, Rails has no `pro` and grants no role, `basic` or membership purchase) is reported but does not fail the gate: it is `account_member` seats whose role sync lags. `backingGrants.backedWithoutPro` counts backing for users Rails does not grant as pro; it grants nothing and never gates.

   Held means nothing revoked: a held legacy subscription, a held bare holder or a held stale-only holder gets no new grant and no user create, email sync or link, and every existing owned row and seat flag for that user stays. That covers a seat Rails no longer lists, the seat's row, and an organization row while the held user holds a granting seat in it (`policy.revokeHeldForHeldUser`, `policy.membershipRevokeHeldForHeldUser`). No hold ever writes, expires or revokes a `rails_legacy_pro_role` quarantine row.

   Orphans (`orphanGrants`: grant lines for a Rails user with no user line, a user deleted in Rails) are revoked: Rails grants a deleted user nothing. The gate still asks for their sha first (above). The receipt counts them and the rows and seats revoked for them (`rowsRevoked`); they count toward the revoke alarm.

5. **Identity pass, when step 4 reports identity conflicts.** A learner who moved from address X to Y in Rails, followed by a new Rails user signing up on X, conflicts until CourseBuilder's copy of the first learner moves to Y. Apply the identity ops (email updates and links) on their own, then plan everything again:

   ```sh
   … pnpm access:delta --export … --out "$WORK/identity" --identity-pass
   … pnpm access:delta --export … --out "$WORK/identity" --identity-pass \
       --apply --expect-plan <changes.planSha256> --confirm-database <database>
   ```

   The identity pass gate checks that the identity ops converge, stay under `--max-identity-ops` and do not collide. `afterIdentityPass` in its receipt previews the full plan's under-grants, over-grants and conflicts once they land. Then run the full dry run again into a new folder (step 3 or 6).

6. At the flip, export Rails again (step 2), then dry-run against production into the folder you will apply from. This writes the `plan.json` that step 7 applies, and it reads production with the same guards (`EGGHEAD_RUNTIME=production`, the production PlanetScale URL):

   ```sh
   EGGHEAD_RUNTIME=production DATABASE_URL="$PRODUCTION_DATABASE_URL" \
     pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/flip"
   ```

   Review `$WORK/flip/receipt.json` as in step 4. If it reports identity conflicts, run step 5 against production, then repeat this step into `$WORK/flip-2`.

7. Apply the reviewed production plan. Writes need `commerceWritesAllowed` (local Docker or production PlanetScale), the target database name, and the reviewed plan's sha. Beta stays read-only for commerce, so the guard refuses beta writes.

   ```sh
   EGGHEAD_RUNTIME=production DATABASE_URL="$PRODUCTION_DATABASE_URL" \
     pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/flip" \
       --apply --expect-plan <changes.planSha256> --confirm-database <database> [--batch-size 100]
   ```

   `--apply` writes exactly `$WORK/flip/plan.json`, in batches of `--batch-size` ops (default 100), one transaction each. The apply receipt records each batch's wall time (`apply.timing`). It refuses when:
   - `--expect-plan` is missing or names a different plan;
   - the plan came from another export, or targets another database name, host or database user (plans and receipts store sha256s of the host and user, never the values). A PlanetScale branch shares its production host, and each branch password has its own user, so a branch-reviewed plan refuses production. A beta or production `DATABASE_URL` without a user name is refused outright;
   - the plan is an identity pass and `--identity-pass` is missing, or the reverse;
   - any gate input differs from the reviewed dry run's (`plan.json` records them as `gateInputs`): `--allow-large-revoke`, `--accept-bare-pro`, `--accept-stale-legacy`, `--accept-orphan-grants`, `--accept-held-org-reach`, `--accept-first-backing`, `--allow-backing-growth`, the sha256 of the `--previous-receipt` file, the `--held-seat-flag` rulings, `--max-identity-ops`, `--legacy-stale-days` and `--bare-pro-active-days`. The refusal names the fields;
   - the export is older than `--max-export-age` (default `2h`; accepts `90m`, `2h`, `1d`) or dated in the future;
   - a fresh read of CourseBuilder no longer produces the same plan;
   - the gate fails.

   Exit 0 means applied and verified: a fresh re-read plans 0 changes. Exit 3 means it stopped early (`--max-batches`); continue with `--resume`. Exit 2 means changes remain after verification. Exit 1 is a refusal or an error.

8. Resume a stopped apply with the same flags and `--resume` in place of `--apply`:

   ```sh
   … pnpm access:delta --export … --out "$WORK/flip" \
       --resume --expect-plan <changes.planSha256> --confirm-database <database>
   ```

   `--resume` runs every check `--apply` runs: the sha, the export age, the gate, and a fresh read. The fresh read may lack ops the stopped run already applied, but any op it plans that the saved plan does not have refuses the resume. Apply and resume write `apply-receipt.json` and `resume-receipt.json`; they never overwrite the reviewed `receipt.json`.

**When an apply or resume is refused or fails.** This covers `CourseBuilder changed since the reviewed dry run`, a `UserCreateCollisionError` or `UserWriteConflictError` (a signup or edit raced the apply; that batch rolled back), exit 2, or an export that got too old. In every case: export Rails again if the export is old, dry-run into a **new** `--out` folder (for example `$WORK/flip-2`), review that receipt, and `--apply` that plan. The old folder stays locked by its unfinished `cursor.json`, which is fine. Every write is idempotent, and the new plan accounts for whatever the partial apply already did.

## Canary and rollback

Use a private, whitespace-separated file of Rails user ids. Pass `--only-users "$WORK/canary-users.txt"` on the dry run, apply, resume and rollback. Selection is bound to the reviewed plan, not the filename; changing its ids refuses apply. A shared organization must include every member or the canary refuses it. Pick individual holders for the first 50-user canary.

The receipt's plan SHA covers the selected operations. The gate still checks the full export and its holds before any selected writes. Post-apply `remainingOps` is scoped to the selected users, so unselected work does not fail canary verification.

```sh
# Use the same runtime, injected URL and acceptance flags as the full dry run.
pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/canary" \
  --only-users "$WORK/canary-users.txt" <reviewed-acceptance-flags>
pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/canary" \
  --only-users "$WORK/canary-users.txt" <reviewed-acceptance-flags> \
  --apply --expect-plan <canary-plan-sha> --confirm-database <database>

# Read-only preview is the default; no export-age deadline on undo.
pnpm access:delta:rollback --plan "$WORK/canary/plan.json" \
  --applied "$WORK/canary/cursor.json" --only-users "$WORK/canary-users.txt"
pnpm access:delta:rollback --plan "$WORK/canary/plan.json" \
  --applied "$WORK/canary/cursor.json" --only-users "$WORK/canary-users.txt" \
  --apply --expect-plan <canary-plan-sha> --confirm-database <database>
```

For a full-plan rollback, omit `--only-users` on both planning and rollback. Rollback never infers a new subset from a full-plan cursor: review a selected plan before applying a canary.

Plan v7 stores full previous row images. Apply locks and checks those images, then saves a full-row post-apply hash in the private cursor. Rollback locks and validates every touched row before changing any. It restores previous columns, including JSON and fractional timestamps, and deletes only rows that were absent before apply, in order: entitlements, memberships, organizations, users. Generated columns are left to MySQL. New references to a created user, membership or organization refuse deletion. The transaction rolls back on any failure, including PlanetScale's transaction timeout; no partial rollback is accepted.

The target must match runtime, database, host hash and database-user hash. Writes use the same commerce guard as apply (beta remains read-only), reviewed SHA and database confirmation. An old cursor without undo proof refuses rollback. Full undo images remain in mode-0600 plan/cursor files, not receipt samples.

Lifecycle: `reviewed -> prepared (undo proof saved inside the batch transaction) -> committed (cursor advanced) -> rollback reviewed -> rolled back`. A crash between prepare and commit can leave an ambiguous batch: a row/hash mismatch refuses resume and rollback rather than guessing. Keep the private files and replan with the desk. A repeated rollback refuses once rows no longer match their post-apply hashes. After a successful rollback the original reviewed apply can run again while the export is fresh; an old export needs a new dry run.

See [the no-sends proof](./access-delta-no-sends.md) for each checked trigger and its source. Before live apply, the desk must confirm the target's DB triggers as well; only the disposable branch was inspected here.

## Export format (`egghead-rails-access-export/v3`)

One JSON object per line, ordered by kind then id:

- `user`: Rails id, email, names, avatar, confirmed and created timestamps, banned flag, sign-in count, token-present flag. Only users that some other line references, including pro holders (the delta ignores pro holders it does not grant: no create, no email sync, no link).
- `role_grant`: a global special role (`lifetime_subscriber`, `VIP`, admin, analyst, content_tester, editor, instructor, publisher).
- `basic_grant`: the global legacy `basic` role (ADR-0007).
- `subscription`: an account subscription in an enabled status, with status, quantity, period start and end (UTC ISO; Rails stores epoch seconds), and every member with `hasMemberRole` (scoped `account_member`) and `hasOwnerRole`. Role-only members have a null `railsAccountUserId`.
- `purchase`: a viewable sellable purchase (`expires_at` null or in the future, and not `access_revoked`), with its bulk flag and coupon country restriction. `refunded` purchases are viewable in Rails, so they are exported.
- `pro_holder`: a user holding the global `pro` role, which is what Rails checks (`Ability#lesson_permissions` calls `is_pro?`; `UserStatusVerifier` syncs it from `Subscription::ProStatusChecker`), with `lastSignInOn`: `GREATEST(current_sign_in_at, last_sign_in_at)` as a date, null if never.
- `backing_grant`: live legacy backing for users Rails grants as pro (`pro`, `basic` or a special role). `gift` is `Gift.active` (`claimed_at` within `COALESCE(duration_months, 12)` months; a NULL `claimed_at` or 0 months is never active), with that end as `expiresAt`. `managed_subscription` is membership of a managed subscription with `is_active`, joined to `subscriptions` through `subscription_id`. It grants only if that row has `cancelled_on IS NULL` and a `currentPeriodEnd` date on or after the export's UTC date. Otherwise the export carries `heldReason` (`no_subscription`, `cancelled`, `no_period_end`, `period_end_stale`) and the delta holds it. Managed-only holders never fall back to a recent-sign-in grant. `legacy_subscription` is `Subscription.active` (`cancelled_on IS NULL` and `willCancelAfterPeriod = false`; NULL is not false), with `currentPeriodEnd` as metadata only.
- `manifest`: the last line, with per-kind counts from the same snapshot, and `backedWithoutPro`: live backing per source for users Rails does not grant as pro (counted, never exported).

The parser refuses a file without the manifest, with lines after it, with counts that disagree, or with duplicate users. A truncated export therefore can never read as "these people lost access". A grant line for a Rails user with no `user` line is an orphan: held, listed in `orphanGrants`, and the gate fails until accepted.

## Delta rules

Identity, in Rails id order:

1. A CourseBuilder user whose `legacyRailsUserId` matches is the user (`matched`).
2. Otherwise, a CourseBuilder user with the same email and no legacy id is linked (`user_link` sets `legacyRailsUserId`). Emails are compared under the `egghead_User.email` column collation: the store pairs export emails with CourseBuilder users in SQL, and reads each export email's `WEIGHT_STRING` so Rails users are compared with each other the same way. `ß` and `ss` are one email, as MySQL's unique key says.
3. Otherwise a new user is created with the July id (`eh_user_<sha1>`). If another user took the email between plan and apply, the batch fails loudly and writes nothing; the next dry run links instead.
4. Empty emails, emails already claimed by a lower Rails id, and emails owned by a different Rails user stay unresolved. Their grants are not projected, and their existing entitlements and seat flags are held, never revoked. They fail the gate.
5. A user matched by legacy id whose Rails email differs from CourseBuilder's (under the collation) gets `user_email_update`: Rails is the source of truth for email until the flip, so they can sign in with the address they use today. If another user already holds the Rails email, the update is held, the old email stays, and the conflict fails the gate. A case-only change is the same email and is left alone.

Expected rows reproduce the July projection's ids, keys and metadata exactly, plus backed `pro`:

- special roles: `egghead_lifetime_access` (lifetime_subscriber, VIP) or `egghead_staff_special_access`;
- `basic`: `egghead_basic_legacy_access`, which the runtime treats as full access;
- each enabled subscription: an organization-level `egghead_all_access_subscription`, plus one seat row per member holding the scoped `account_member` role. `expiresAt` stays null, and `currentPeriodEnd` is metadata only (lenient law). Members without the role get a membership row only. Several enabled subscriptions on one account share one membership;
- purchases: `egghead_membership_access` for `Resource::Membership`, otherwise `egghead_playlist_access`, with the purchase's expiry (anything past MySQL's 2038 limit means no expiry). Bulk playlist pools and purchases without a sellable grant nothing;
- backed `pro`: one `egghead_all_access_subscription` row per live backing of a user Rails grants as pro, with source type `rails_gift` (expires with the gift; an end past 2038 means no expiry), `rails_managed_subscription` or `rails_legacy_subscription` (no expiry; the period end is metadata, and `legacySubscriptionsPastPeriodEnd` counts granted ones already past it). A legacy subscription past `--legacy-stale-days` is held instead. When the backing lapses or the user loses `pro`, the row expires or is revoked like any owned row. The runtime enforces a gift's expiry because it exempts only `rails_account_subscription` rows from `expiresAt`;
- bare `pro` (including a holder whose only backing is a stale legacy subscription) signed in within `--bare-pro-active-days`: one `egghead_all_access_subscription` row with source type `rails_bare_pro_active`, keyed on the Rails user id, no expiry, lenient law, with any stale subscription ids in `staleLegacySubscriptionIds`. The sign-in date stays in the plan and receipt, not the row: it would churn an update every run. The window decides only the first grant: a later run keeps the row while Rails keeps the user's `pro` role, and revokes it when the role goes.

Change classes, applied in this order so a crash never removes access before granting it:

| Class                 | When                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `user_create`         | Rails user with no CourseBuilder match.                                                                 |
| `user_email_update`   | Matched by legacy id, but the Rails email changed. Guarded on the old email; a raced write fails.       |
| `user_link`           | Email match to a CourseBuilder user without a legacy id. Re-read after write; a raced link fails.       |
| `organization_create` | Subscription account with no CourseBuilder organization.                                                |
| `membership_create`   | Member with no membership row.                                                                          |
| `membership_update`   | Membership role, user or seat flags differ (including losing `account_member` while staying a member).  |
| `entitlement_grant`   | Expected row missing, or soft-deleted (`restored`, which also clears the delta's revoke marker).        |
| `entitlement_extend`  | The only change is a later `expiresAt` or `currentPeriodEnd`.                                           |
| `entitlement_update`  | Any other difference (status, quantity, owner, earlier expiry). Extra stored metadata is kept.          |
| `membership_revoke`   | A Rails-sourced membership with no Rails member row still grants a seat; clears `hasAccountMemberRole`. |
| `entitlement_revoke`  | A live row with a delta-owned source type that Rails no longer grants; soft-deletes it.                 |
| `entitlement_expire`  | The same, for a row whose `expiresAt` had passed by export time. It does not count toward the alarm.    |

Owned source types: `rails_user_role`, `rails_account_subscription`, `rails_sellable_purchase`, `rails_legacy_basic_role`, `rails_gift`, `rails_managed_subscription`, `rails_legacy_subscription`, `rails_bare_pro_active`. CourseBuilder's own rows (`stripe_subscription` and anything else) and the legacy-pro quarantine rows (`rails_legacy_pro_role`) are never touched: the store never selects them for an op.

A seat flag is never cleared on an organization that also holds a live grant the delta does not own, such as a CourseBuilder Stripe team subscription, unless a person rules `--held-seat-flag <id>=clear`. The receipt lists these holds (`heldSeatFlags`, with any ruling) and counts them (`membershipFlagHeldForNativeOrganization`).

Revokes trip an alarm when access removals and moves exceed the larger of 50 or 1% of live owned rows plus granting Rails seat flags. They are `entitlement_revoke`, `membership_revoke`, a `membership_update` that clears the seat flag, an `entitlement_update` that changes the row's user, type or organization, and an `entitlement_expire` on a subscription row. `largeRevoke` counts each kind. Other expiries do not count. The gate then fails, and `--apply` refuses until `--allow-large-revoke`.

Writes that find the row changed since the plan fail the whole batch and write nothing: a `user_create` whose email another user took (`UserCreateCollisionError`), and a `user_link` or `user_email_update` that the re-read shows did not land (`UserWriteConflictError`). Dry-run into a new `--out` folder and apply that plan (see "When an apply or resume is refused or fails").

## Receipt (`receipt.json`)

It holds no emails or names. It contains:

- the export sha256 and manifest, and the analysis clock;
- snapshot counts;
- counts per class and per reason, the plan sha256, and identity outcomes;
- the target as runtime, database name and a sha256 of the host;
- the gate inputs (`gateInputs`), as `plan.json` records them;
- identity conflicts, identity-op counts and collisions, and the Rails pro-holder cross-check (every held bare `pro` id with the list's sha256 and a spread sample, the granted bare-active ids, sign-in buckets, and up to 20 ids the other way);
- `staleLegacyReconciliation`: every user with a pro-eligible stale legacy subscription in exactly one bucket (`held`, `grantedInWindow`, `orphan`, `grantedAnotherWay` split by reason, `other`, which should be 0), and `grantedAnotherWayWithoutAllAccess`, which must be 0;
- granted rows per gated source type, backing without `pro`, growth against `--previous-receipt`, held legacy subscriptions (with its sha256), orphans (with their sha256) and the rows revoked for them, `revokesOnHeldUsers` (`ops` and `missingTargets` must read 0), `heldOrganizationReach`, held seat flags with rulings, accepted over-grants by `keep` and by hold, and `afterIdentityPass` on an identity pass;
- policy counts: bulk, country-restricted, members without the role, purchases without a sellable, held revokes and held seat flags;
- 20 sample ops spread across classes;
- the shadow compare before and after the simulated apply, with under- and over-grant samples;
- whether a second pass would still change anything;
- the revoke alarm (each removal and move kind counted separately) and the gate.

Apply and resume receipts add the cursor, the batch size, per-batch wall times and a post-apply verification from a fresh read.

## Tests

```sh
pnpm access:delta:test          # pure suite; the MySQL suite skips
ACCESS_DELTA_MYSQL_URL=mysql://…@127.0.0.1:PORT/<name>_test pnpm access:delta:test
```

The MySQL suite drops and recreates four `egghead_` tables in a disposable loopback database whose name ends in `_test`. `scripts/access-delta-fixture-proof.ts` also runs it against the exact in-process leased fixture user, bound by `ACCESS_DELTA_MYSQL_FIXTURE_USER_SHA256`, after the round trip on the fixture's existing live-schema tables. No live/beta credential is accepted by that runner. It reads with a page size of 3 and a chunk size of 2, so keyset paging and chunked lookups really run. It also drives the CLI as a child process. `pnpm check` runs only the pure suite; the MySQL suite needs a fixture database, so CI does not run it.

All fixture data is synthetic (`scripts/access-delta.fixtures.ts`): emails are `@example.test` and ids are invented.

The pure suite covers:

- renewed (extended) user, cancelled user and new paying user;
- a team with an owner without a seat, a kept seat, a new seat and a removed seat;
- lifetime role, lifetime (no-expiry) purchase, basic legacy role;
- trialing subscription with a role-only member, two subscriptions on one account;
- lapsed `past_due` user who keeps access;
- beta signup linked by email, collation-paired emails;
- bulk buyer, purchase without a sellable, expired purchase classed as `entitlement_expire`;
- CourseBuilder-native and quarantine rows left alone, seat flags held for native organizations;
- identity conflict, held revoke and held seat flag;
- collation twins (`ß`/`ss`), email drift and a held email update;
- the pro-holder cross-check both ways;
- seat-flag clears in the revoke alarm;
- host binding and export age;
- backed `pro` from a gift, a managed subscription and a legacy subscription, an expired gift, bare `pro` accepted by its exact id set, and backing growth;
- backing for a user without `pro` (counted, not granted) and for a `basic` user (granted);
- first-run acceptance by exact count, and `--previous-receipt` replacing it;
- a stale and an undated legacy subscription held by sha, a wider window granting it, and an earlier run's row kept with its over-grant excused;
- the stale legacy reconciliation with a user in every bucket;
- a stale-only holder inside the sign-in window granted `rails_bare_pro_active`, one list per person, stale and bare sign-in buckets kept apart, and an earlier bare-active row kept outside the window;
- bare `pro` granted inside the sign-in window, held outside it, dormant holders never touched, sign-in buckets, and an earlier row kept while `pro` stays and revoked when it goes;
- `basic` holders and membership purchasers off the bare list;
- quarantine rows untouched for bare, backed and stale holders;
- an orphan Rails user revoked (rows and seat) and counted;
- held means nothing revoked: a dormant bare holder keeps a June seat, its row and the organization row; a held member's seat-flag clear is held; a held stale-only holder's rows are kept with no user create; a held user's unlabelled row is found through the linked user; and the receipt join catches a plan that revokes them;
- `rails_bare_pro_active` metadata without a sign-in date, and through MySQL: applied, re-read, a fresh plan of 0 ops, and the runtime granting it;
- round 8: orphans gated by sha, held-organization reach counted and gated by sha, an id both held and orphaned refused, the join failing on a missing target and catching moves and earlier expiries, a held seat flag keeping its flag while other changes apply, an empty database user refused, and `--resume` refusing another database user;
- `--previous-receipt` format, strictly-earlier export, target and gate checks, `--now` refused with `--apply`, and a plan reviewed as another database user refused;
- `keep` scoped to the kept seat;
- the shadow list complete beyond any sample size, and the summary invariant;
- gate inputs compared field by field;
- the identity-op cap and every collision kind;
- type and organization changes counted as moves;
- a gift past 2038;
- an X to Y email move plus a new signup on X, cleared by an identity pass;
- seat-flag rulings `clear`, `keep` and a stale ruling;
- access moves, seat clears by update and subscription expiries in the alarm;
- update and revoke dedupe, restored row, revoke alarm;
- apply preconditions, export clock;
- truncated and inconsistent exports.

The MySQL suite covers:

- dry run without writes;
- apply with every runtime verdict checked by the app's own `evaluateContentAccessForUser`;
- idempotent re-runs;
- resume after a stop and after a crash between commit and cursor save;
- paging and chunking;
- restore clearing the revoke marker;
- an unresolved member keeping their seat;
- a signup collision failing loudly and then linking;
- `ß`/`ss` pairing with CourseBuilder users and between Rails users;
- an email update through SQL, and a raced address failing the batch;
- a raced `user_link` failing the batch;
- the CLI refusing `--apply` without the plan sha, on a stale export, on a failing gate and on a large revoke, refusing an `--allow-large-revoke` added only at apply, then applying once the dry run has it;
- a dry run leaving all four tables' `CHECKSUM TABLE` unchanged;
- the identity pass then the full pass through SQL;
- the runtime denying an expired `rails_gift` row and granting a live one;
- a quarantine row byte-identical through a backed apply and a bare apply;
- the CLI refusing an apply whose gate inputs differ from the dry run's (an added flag, a missing acceptance), binding `--previous-receipt` by sha, writing a default `--out` under `$XDG_STATE_HOME` with mode 0700, refusing writes without `--out`, and rejecting malformed `--held-seat-flag` and `--accept-first-backing`;
- the CLI refusing an `--out` inside the repo, tightening an existing folder to 0700, refusing `--resume` without the sha, on an export that aged, and on a drifted database, a refused apply recovered through a new `--out`, and the identity pass end to end.
