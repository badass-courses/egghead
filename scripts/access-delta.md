# Paid-access delta (Rails to CourseBuilder)

`pnpm access:delta` re-projects who has paid access from a Rails export into CourseBuilder. It replaces the one-shot July 2026 projection with a delta you can rehearse now and rerun at the flip.

Law: **ADR-0006, lenient at the flip.** Anyone Rails grants today keeps access. A subscription in `trialing`, `active` or `past_due` grants, whatever its period end says.

## Pieces

| File                                              | Role                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/sql/rails-access-export.sql`             | Read-only Postgres export, run by the desk on Rails. Emits JSONL.                         |
| `apps/web/src/access/rails-access-delta.ts`       | Pure: parse and verify the export, resolve identity, build expected rows, diff, simulate. |
| `apps/web/src/access/rails-access-shadow.ts`      | Pure: "Rails says X, CourseBuilder says Y" per user.                                      |
| `apps/web/src/access/rails-access-delta-store.ts` | CourseBuilder reads and idempotent writes through the app's Drizzle database.             |
| `apps/web/src/access/rails-access-delta-plan.ts`  | Plan and cursor files for apply and resume.                                               |
| `scripts/access-delta-run.ts`                     | Analysis, receipt, apply preconditions and verification shared by the CLI and tests.      |
| `scripts/access-delta.ts`                         | CLI.                                                                                      |
| `scripts/access-delta.test.ts`                    | Pure tests plus the MySQL fixture suite.                                                  |

## Desk commands

The export needs a Rails read connection, and the dry run needs a CourseBuilder read connection. Neither prints secrets. Keep every output file in a private directory (`$WORK` below, mode 0700). `plan.json` holds customer emails and names; it must never leave that directory.

1. Export from Rails (Postgres; a read replica is fine). The SQL opens a `READ ONLY` repeatable-read transaction:

   ```sh
   psql "$RAILS_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
     -f scripts/sql/rails-access-export.sql -o "$WORK/rails-access-export.jsonl"
   tail -1 "$WORK/rails-access-export.jsonl"   # the manifest line
   ```

2. Dry run against beta. It is read-only, and the beta guard needs `EGGHEAD_BETA_DB_APPROVED=true` and the PlanetScale URL (inject it with agent-secrets rather than exporting it):

   ```sh
   EGGHEAD_RUNTIME=beta EGGHEAD_BETA_DB_APPROVED=true DATABASE_URL="$BETA_DATABASE_URL" \
     pnpm access:delta --export "$WORK/rails-access-export.jsonl" --out "$WORK/beta-dry-run"
   ```

   The analysis clock is the export's `exportedAt`, the moment Rails decided what had expired. `--now <iso>` overrides it. CourseBuilder is read in one `REPEATABLE READ, READ ONLY` transaction; `--no-snapshot-transaction` turns that off if the driver or host rejects it.

3. Ask about one learner. Repeat `--user` as needed; it accepts a Rails user id, a CourseBuilder user id or an email:

   ```sh
   … pnpm access:delta --export … --out … --user 123456 --user learner@example.com
   ```

   Each prints one JSON line with `railsSays`, `cbSays` and a verdict, both now and after the simulated apply.

4. Read `<out>/receipt.json`. The flip gate is `gate.pass`, and `changes.planSha256` names the plan you reviewed. The gate fails when, after the simulated apply, any Rails-granted user is still under-granted (including unresolved identities), any user is over-granted from Rails rows, the plan does not converge, or revokes trip the alarm without `--allow-large-revoke`.

5. At the flip, apply the reviewed plan on the production runtime. Writes need `commerceWritesAllowed` (local Docker or production PlanetScale), the target database name, and the reviewed plan's sha. Beta stays read-only for commerce, so the guard refuses beta writes.

   ```sh
   EGGHEAD_RUNTIME=production DATABASE_URL="$PRODUCTION_DATABASE_URL" \
     pnpm access:delta --export … --out "$WORK/flip" \
       --apply --expect-plan <changes.planSha256> --confirm-database <database> [--batch-size 500]
   ```

   `--apply` writes exactly `<out>/plan.json`. It refuses when:
   - `--expect-plan` is missing or names a different plan;
   - the plan came from another export or targets another database;
   - a fresh read of CourseBuilder no longer produces the same plan (run the dry run again and review it);
   - the gate fails.

   Exit 0 means applied and verified: a fresh re-read plans 0 changes. Exit 3 means it stopped early (`--max-batches`); continue with `--resume`. Exit 2 means changes remain after verification; run the dry run again and review it. An unfinished apply locks its `--out` folder against new dry runs and applies.

   ```sh
   … pnpm access:delta --export … --out "$WORK/flip" --resume --confirm-database <database>
   ```

   Apply and resume write `apply-receipt.json` and `resume-receipt.json`; they never overwrite the reviewed `receipt.json`.

## Export format (`egghead-rails-access-export/v1`)

One JSON object per line, ordered by kind then id:

- `user`: Rails id, email, names, avatar, confirmed and created timestamps, banned flag, sign-in count, token-present flag. Only users that some other line references.
- `role_grant`: a global special role (`lifetime_subscriber`, `VIP`, admin, analyst, content_tester, editor, instructor, publisher).
- `basic_grant`: the global legacy `basic` role (ADR-0007).
- `subscription`: an account subscription in an enabled status, with status, quantity, period start and end (UTC ISO; Rails stores epoch seconds), and every member with `hasMemberRole` (scoped `account_member`) and `hasOwnerRole`. Role-only members have a null `railsAccountUserId`.
- `purchase`: a viewable sellable purchase (`expires_at` null or in the future, and not `access_revoked`), with its bulk flag and coupon country restriction. `refunded` purchases are viewable in Rails, so they are exported.
- `manifest`: the last line, with per-kind counts from the same snapshot.

The parser refuses a file without the manifest, with lines after it, with counts that disagree, with duplicate users, or with references to users that have no `user` line. A truncated export therefore can never read as "these people lost access".

## Delta rules

Identity, in Rails id order:

1. A CourseBuilder user whose `legacyRailsUserId` matches is the user (`matched`).
2. Otherwise, a CourseBuilder user with the same email and no legacy id is linked (`user_link` sets `legacyRailsUserId`). Emails are paired in SQL under the column's own collation, so `ß` and `ss` match the way MySQL's unique key does.
3. Otherwise a new user is created with the July id (`eh_user_<sha1>`). If another user took the email between plan and apply, the batch fails loudly and writes nothing; the next dry run links instead.
4. Empty emails, emails already claimed by a lower Rails id, and emails owned by a different Rails user stay unresolved. Their grants are not projected, and their existing entitlements and seat flags are held, never revoked. They fail the gate.

Expected rows reproduce the July projection's ids, keys and metadata exactly:

- special roles: `egghead_lifetime_access` (lifetime_subscriber, VIP) or `egghead_staff_special_access`;
- `basic`: `egghead_basic_legacy_access`, which the runtime treats as full access;
- each enabled subscription: an organization-level `egghead_all_access_subscription`, plus one seat row per member holding the scoped `account_member` role. `expiresAt` stays null, and `currentPeriodEnd` is metadata only (lenient law). Members without the role get a membership row only. Several enabled subscriptions on one account share one membership;
- purchases: `egghead_membership_access` for `Resource::Membership`, otherwise `egghead_playlist_access`, with the purchase's expiry (anything past MySQL's 2038 limit means no expiry). Bulk playlist pools and purchases without a sellable grant nothing.

Change classes, applied in this order so a crash never removes access before granting it:

| Class                 | When                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `user_create`         | Rails user with no CourseBuilder match.                                                                 |
| `user_link`           | Email match to a CourseBuilder user without a legacy id.                                                |
| `organization_create` | Subscription account with no CourseBuilder organization.                                                |
| `membership_create`   | Member with no membership row.                                                                          |
| `membership_update`   | Membership role, user or seat flags differ (including losing `account_member` while staying a member).  |
| `entitlement_grant`   | Expected row missing, or soft-deleted (`restored`, which also clears the delta's revoke marker).        |
| `entitlement_extend`  | The only change is a later `expiresAt` or `currentPeriodEnd`.                                           |
| `entitlement_update`  | Any other difference (status, quantity, owner, earlier expiry). Extra stored metadata is kept.          |
| `membership_revoke`   | A Rails-sourced membership with no Rails member row still grants a seat; clears `hasAccountMemberRole`. |
| `entitlement_revoke`  | A live row with a delta-owned source type that Rails no longer grants; soft-deletes it.                 |
| `entitlement_expire`  | The same, for a row whose `expiresAt` had passed by export time. It does not count toward the alarm.    |

Owned source types: `rails_user_role`, `rails_account_subscription`, `rails_sellable_purchase`, `rails_legacy_basic_role`. CourseBuilder's own rows (`stripe_subscription` and anything else) and the legacy-pro quarantine rows (`rails_legacy_pro_role`) are never touched.

A seat flag is never cleared on an organization that also holds a live grant the delta does not own, such as a CourseBuilder Stripe team subscription. The receipt counts these holds (`membershipFlagHeldForNativeOrganization`), and the resulting over-grant fails the gate for a person to decide.

Revokes over the larger of 50 or 1% of live owned rows trip an alarm. The gate then fails, and `--apply` refuses until `--allow-large-revoke`.

## Receipt (`receipt.json`)

It holds no emails or names. It contains:

- the export sha256 and manifest, and the analysis clock;
- snapshot counts;
- counts per class and per reason, the plan sha256, and identity outcomes;
- policy counts: bulk, country-restricted, members without the role, purchases without a sellable, held revokes and held seat flags;
- 20 sample ops spread across classes;
- the shadow compare before and after the simulated apply, with under- and over-grant samples;
- whether a second pass would still change anything;
- the revoke alarm and the gate.

Apply and resume receipts add the cursor and a post-apply verification from a fresh read.

## Tests

```sh
pnpm access:delta:test          # pure suite; the MySQL suite skips
ACCESS_DELTA_MYSQL_URL=mysql://…@127.0.0.1:PORT/<name>_test pnpm access:delta:test
```

The MySQL suite drops and recreates four `egghead_` tables in a disposable loopback database whose name ends in `_test`. It reads with a page size of 3 and a chunk size of 2, so keyset paging and chunked lookups really run.

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
- `ß`/`ss` pairing.
