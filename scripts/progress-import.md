# Progress import production write gate

Production import and rollback apply require both:

- `EGGHEAD_PROGRESS_IMPORT_PRODUCTION_APPROVED=true`;
- `--confirm-database <name>` matching the connection's `SELECT DATABASE()` result.

Dry runs remain read-only. Beta still uses its existing read approval and `EGGHEAD_PROGRESS_IMPORT_APPLY_APPROVED=true` write approval.

## Canary, undo, re-apply

Create a finished full-file dry-run receipt against the target first. Apply binds that receipt to the export hash and salted connection identity, including the branch-specific database user.

```sh
pnpm progress:import --source export.jsonl --receipt dry-run.json
pnpm progress:import --source export.jsonl --apply \
  --confirm-database <name> --expect-dry-run dry-run.json \
  --cursor canary.cursor.json --max-users 50 \
  --max-rows-per-transaction 100 --pause-ms 250 --receipt canary.json
pnpm progress:import:rollback --run <runId> --apply \
  --confirm-database <name> --manifest canary.cursor.json.manifest.jsonl
```

`--max-users 50` caps source users, not just matched users. The manifest contains only users whose progress was planned for writing within that cap. Rollback uses the manifest plus the run's stamps and leaves learner edits alone, counted as `changedSinceImport`.

After proving rollback, re-apply with a **new cursor and manifest**, using the same bound dry-run receipt. Keep the first canary's artifacts. Continuing after the re-applied canary uses that re-apply cursor, which starts after its last Rails user ID. A new `--max-users` cap applies to that invocation, not the lifetime of the cursor.

`--pause-ms` defaults to 0 and sleeps between import transactions, including batch boundaries. Transaction logs on stderr show duration and row count. Choose transaction size and pause from observed live latency; these example values are not a latency guarantee.

## Inserts only

Production apply refuses a bound receipt unless these counts are present and zero: `toUpdate`, `keptCbCompleted`, `keptCbNewer`, `keptFieldsNotObject`, `collapsedDuplicates`, `unmatchedEmailConflict`, and `unmatchedSharedEmail`.

Planning stops on existing progress. The only resume exception is an unchanged insert stamped by the same run, with matching Rails user, completion time and import timestamp. A production transaction emits plain `INSERT`, never an upsert or update. A duplicate key or unexpected stamped-row count rolls back that transaction and stops the import. Earlier committed transactions remain committed; their users remain in the write-ahead manifest. A partial batch can resume using the same cursor and run ID.

## SQL and side effects

`apps/web/src/progress/import.ts` and `import-rollback.ts` write only `egghead_ResourceProgress`. They read users, content catalog tables, progress and database metadata. `import-db.ts` opens the connection, sets UTC and reads the server database name. The two CLI entrypoints write local receipts, cursors and manifests. No path calls Inngest, mail delivery or certificate code.

Check that boundary with:

```sh
rg -n 'INSERT INTO|UPDATE egghead_|DELETE FROM|JOIN |FROM ' \
  apps/web/src/progress/import{,-rollback,-catalog,-db}.ts
rg -ni 'inngest|sendMail|sendEmail|certificate|fetch\(' \
  apps/web/src/progress/import{,-rollback,-catalog,-db,-cli,-source}.ts \
  scripts/progress-import{,-rollback}.ts
```

The second search must return no matches.

## Fixture proof

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/progress-import-fixture-proof.ts
pnpm progress:import:test
pnpm check
```

The explicit fixture runner leases only the fixture admin credential in-process. It accepts no database URL argument, requires zero database triggers, uses synthetic rows in the existing schema, proves a 50-user canary from 51 source users, checks the exact manifest, rolls back 50, re-applies 50, checks conflicts and same-run resume, and cleans up only its own synthetic rows. Do not run other fixture writers alongside it.
