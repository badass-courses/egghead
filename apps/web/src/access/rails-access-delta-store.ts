// CourseBuilder reads and writes for the Rails access delta, through the app's
// Drizzle database (`db/adapter.ts`). Every write is an idempotent upsert or a
// guarded update keyed by the projection's deterministic ids, so re-running a
// batch after a crash is safe.

import { and, asc, eq, getTableName, gt, inArray, isNull, or, sql } from "drizzle-orm";

import type { getEggheadDatabase } from "../db/adapter";
import { entitlements, organization, organizationMemberships, users } from "../db/schema";
import {
  DELTA_OWNED_SOURCE_TYPES,
  normalizeEmail,
  projectionIds,
  type CbEntitlement,
  type CbMembership,
  type CbSnapshot,
  type CbUser,
  type DeltaOp,
  type JsonRecord,
  type RailsAccessExport,
} from "./rails-access-delta";
import type { ApplyCursor } from "./rails-access-delta-plan";
import {
  captureUndo,
  checkUndoBaseline,
  stampUndo,
  undoForOps,
  type UndoRow,
} from "./rails-access-delta-rollback";

export type EggheadDatabase = ReturnType<typeof getEggheadDatabase>;
type Reader = Pick<EggheadDatabase, "select" | "execute">;
type Writer = Pick<EggheadDatabase, "insert" | "update" | "select">;

const OWNED = [...DELTA_OWNED_SOURCE_TYPES];

export interface SnapshotReadOptions {
  /** Rows per keyset page. PlanetScale caps a query at 100k rows. */
  readonly pageSize: number;
  /** Ids or emails per lookup query. */
  readonly chunkSize: number;
  /** Lookup queries in flight at once. */
  readonly concurrency: number;
  /**
   * Read everything in one `REPEATABLE READ, READ ONLY` transaction, so live
   * writes cannot mix states. Queries then share one connection, and the whole
   * read must finish inside the host's transaction time limit. Off, each query
   * reads committed state; the apply-time fresh-plan check and post-apply
   * verification catch anything that moved.
   */
  readonly consistent: boolean;
}

export const DEFAULT_READ_OPTIONS: SnapshotReadOptions = {
  pageSize: 5000,
  chunkSize: 1000,
  concurrency: 4,
  consistent: true,
};

export class UserCreateCollisionError extends Error {
  override readonly name = "UserCreateCollisionError";
}

/** A link or email update found the user changed since the plan; the batch rolls back. */
export class UserWriteConflictError extends Error {
  override readonly name = "UserWriteConflictError";
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/** Map with at most `limit` promises in flight; results keep input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    const index = next++;
    const item = items[index];
    if (item === undefined) return;
    results[index] = await run(item);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function isoOrNull(value: Date | null) {
  return value ? value.toISOString() : null;
}

function dateOrNull(value: string | null) {
  return value ? new Date(value) : null;
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

/** Keyset pages, one query at a time. */
async function readPages<T extends { id: string }>(
  pageSize: number,
  readPage: (afterId: string) => Promise<T[]>,
  afterId = "",
  collected: T[] = [],
): Promise<T[]> {
  const page = await readPage(afterId);
  for (const row of page) collected.push(row);
  const last = page.at(-1);
  return !last || page.length < pageSize
    ? collected
    : readPages(pageSize, readPage, last.id, collected);
}

interface FoundUser {
  readonly id: string;
  readonly email: string;
  readonly legacyRailsUserId: string | null;
  readonly probeEmail: string | null;
}

/**
 * Users whose email equals one of `emails` under the column's own collation,
 * paired with the export email that matched (`probeEmail`).
 */
async function usersByEmail(reader: Reader, emails: readonly string[]): Promise<FoundUser[]> {
  const probe = sql.join(
    emails.map((email) => sql`SELECT ${email} AS email`),
    sql` UNION ALL `,
  );
  const result = await reader.execute(sql`
    SELECT ${users.id} AS id, ${users.email} AS email,
           ${users.legacyRailsUserId} AS legacyRailsUserId, probe.email AS probeEmail
    FROM ${users} JOIN (${probe}) AS probe ON ${users.email} = probe.email
  `);
  const [rows] = result;
  if (!Array.isArray(rows)) return [];
  const list: unknown[] = rows;
  return list.flatMap((row) => {
    const record = asRecord(row);
    const id = textOrNull(record["id"]);
    const email = textOrNull(record["email"]);
    return id && email
      ? [
          {
            id,
            email,
            legacyRailsUserId: textOrNull(record["legacyRailsUserId"]),
            probeEmail: textOrNull(record["probeEmail"]),
          },
        ]
      : [];
  });
}

const SQL_NAME = /^[A-Za-z0-9_]+$/;

/** Charset and collation of `egghead_User.email`, as the unique key compares it. */
async function emailColumnCollation(reader: Reader) {
  const [rows] = await reader.execute(sql`
    SELECT CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${getTableName(users)} AND COLUMN_NAME = 'email'
  `);
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const record = asRecord(list[0]);
  const charset = textOrNull(record["charset"]);
  const collation = textOrNull(record["collation"]);
  if (!charset || !collation || !SQL_NAME.test(charset) || !SQL_NAME.test(collation)) {
    throw new Error("could not read the egghead_User.email collation from information_schema");
  }
  return { charset, collation };
}

/**
 * Each email's weight under the email column's collation (`WEIGHT_STRING`).
 * Equal weights mean the unique key treats the emails as one, so the delta can
 * pair Rails users with each other the way MySQL will (`ß` and `ss`, for one).
 */
async function emailWeights(
  reader: Reader,
  emails: readonly string[],
  column: { charset: string; collation: string },
) {
  const probe = sql.join(
    emails.map((email) => sql`SELECT ${email} AS email`),
    sql` UNION ALL `,
  );
  const weight = sql.raw(
    `HEX(WEIGHT_STRING(CONVERT(probe.email USING ${column.charset}) COLLATE ${column.collation}))`,
  );
  const [rows] = await reader.execute(
    sql`SELECT probe.email AS email, ${weight} AS weight FROM (${probe}) AS probe`,
  );
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  return list.flatMap((row) => {
    const record = asRecord(row);
    const email = textOrNull(record["email"]);
    const value = textOrNull(record["weight"]);
    return email !== null && value !== null ? [{ email, weight: value }] : [];
  });
}

async function readAll(
  reader: Reader,
  railsExport: RailsAccessExport,
  options: SnapshotReadOptions,
): Promise<CbSnapshot> {
  const lookup = <R>(values: readonly string[], read: (chunk: string[]) => Promise<R[]>) =>
    mapLimited(chunks(values, options.chunkSize), options.concurrency, read).then((results) =>
      results.flat(),
    );
  const userColumns = {
    id: users.id,
    email: users.email,
    legacyRailsUserId: users.legacyRailsUserId,
  };
  const emails = [
    ...new Set(railsExport.users.map((user) => normalizeEmail(user.email)).filter(Boolean)),
  ];
  const wantedOrganizations = [
    ...new Set(
      railsExport.subscriptions
        .map((sub) => sub.railsAccountId)
        .filter((id): id is string => Boolean(id))
        .map((id) => projectionIds.organization(id)),
    ),
  ];

  const byRailsId = await lookup(
    railsExport.users.map((user) => user.railsUserId),
    (ids) => reader.select(userColumns).from(users).where(inArray(users.legacyRailsUserId, ids)),
  );
  const byEmail = await lookup(emails, (batch) => usersByEmail(reader, batch));
  const column = await emailColumnCollation(reader);
  const weights = await lookup(emails, (batch) => emailWeights(reader, batch, column));
  const entitlementRows = await readPages(options.pageSize, (afterId) =>
    reader
      .select({
        id: entitlements.id,
        entitlementType: entitlements.entitlementType,
        userId: entitlements.userId,
        organizationId: entitlements.organizationId,
        organizationMembershipId: entitlements.organizationMembershipId,
        sourceType: entitlements.sourceType,
        sourceId: entitlements.sourceId,
        metadata: entitlements.metadata,
        expiresAt: entitlements.expiresAt,
        deletedAt: entitlements.deletedAt,
      })
      .from(entitlements)
      .where(
        and(
          gt(entitlements.id, afterId),
          or(isNull(entitlements.deletedAt), inArray(entitlements.sourceType, OWNED)),
        ),
      )
      .orderBy(asc(entitlements.id))
      .limit(options.pageSize),
  );
  const membershipRows = await readPages(options.pageSize, (afterId) =>
    reader
      .select({
        id: organizationMemberships.id,
        organizationId: organizationMemberships.organizationId,
        userId: organizationMemberships.userId,
        role: organizationMemberships.role,
        fields: organizationMemberships.fields,
      })
      .from(organizationMemberships)
      .where(gt(organizationMemberships.id, afterId))
      .orderBy(asc(organizationMemberships.id))
      .limit(options.pageSize),
  );
  const organizationRows = await lookup(wantedOrganizations, (ids) =>
    reader.select({ id: organization.id }).from(organization).where(inArray(organization.id, ids)),
  );

  const found = new Map<string, { user: CbUser; matched: Set<string> }>();
  const remember = (row: { id: string; email: string; legacyRailsUserId: string | null }) => {
    const entry = found.get(row.id) ?? {
      user: {
        id: row.id,
        email: row.email,
        legacyRailsUserId: row.legacyRailsUserId,
        matchedExportEmails: [],
      },
      matched: new Set<string>(),
    };
    found.set(row.id, entry);
    return entry;
  };
  for (const row of byRailsId) remember(row);
  for (const row of byEmail) {
    const entry = remember(row);
    if (row.probeEmail) entry.matched.add(row.probeEmail);
  }

  return {
    // Sorted so the snapshot does not depend on chunk size or query order.
    users: [...found.values()]
      .map(
        ({ user, matched }): CbUser => ({
          id: user.id,
          email: user.email,
          legacyRailsUserId: user.legacyRailsUserId,
          matchedExportEmails: [...matched].toSorted(),
        }),
      )
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    exportEmailKeys: Object.fromEntries(
      weights
        .map((row): [string, string] => [row.email, row.weight])
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    entitlements: entitlementRows.map(
      (row): CbEntitlement => ({
        id: row.id,
        entitlementType: row.entitlementType,
        userId: row.userId,
        organizationId: row.organizationId,
        organizationMembershipId: row.organizationMembershipId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        metadata: asRecord(row.metadata),
        expiresAt: isoOrNull(row.expiresAt),
        deletedAt: isoOrNull(row.deletedAt),
      }),
    ),
    memberships: membershipRows.map(
      (row): CbMembership => ({
        id: row.id,
        organizationId: row.organizationId,
        userId: row.userId,
        role: row.role,
        fields: asRecord(row.fields),
      }),
    ),
    organizationIds: organizationRows.map((row) => row.id).toSorted(),
  };
}

/** Read everything the delta and shadow compare need from CourseBuilder. Read-only. */
export function readCbSnapshot(
  db: EggheadDatabase,
  railsExport: RailsAccessExport,
  options: SnapshotReadOptions = DEFAULT_READ_OPTIONS,
): Promise<CbSnapshot> {
  if (!options.consistent) return readAll(db, railsExport, options);
  return db.transaction((transaction) => readAll(transaction, railsExport, options), {
    // REPEATABLE READ fixes the snapshot at the first read, so every query below
    // sees one state. Not `withConsistentSnapshot`: drizzle-orm 0.36 joins it to
    // the access mode without a comma, which MySQL rejects.
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** CourseBuilder user ids by email, for `--user <email>` lookups outside the export. Read-only. */
export async function findCbUsersByEmail(db: EggheadDatabase, emails: readonly string[]) {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (wanted.length === 0) return [];
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, wanted));
}

async function createUser(
  writer: Writer,
  op: Extract<DeltaOp, { kind: "user_create" }>,
  now: Date,
) {
  // The email unique key would turn the upsert into a silent no-op and leave
  // entitlements pointing at a user id that does not exist. Check under the
  // column's collation first, and fail the batch loudly instead.
  const holders = await writer
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, op.user.email));
  const other = holders.find((holder) => holder.id !== op.user.id);
  if (other) {
    throw new UserCreateCollisionError(
      `Rails user ${op.railsUserId}: CourseBuilder user ${other.id} already holds this email. ` +
        "Nothing in this batch was written. Dry-run into a NEW --out folder, review it and --apply that plan; this partial apply is safe to leave.",
    );
  }
  await writer
    .insert(users)
    .values({
      id: op.user.id,
      email: op.user.email,
      name: op.user.name,
      role: op.user.role,
      fields: op.user.fields,
      emailVerified: dateOrNull(op.user.emailVerified),
      image: op.user.image,
      createdAt: dateOrNull(op.user.createdAt) ?? now,
    })
    .onDuplicateKeyUpdate({ set: { id: sql`${users.id}` } });
  const created = await writer.select({ id: users.id }).from(users).where(eq(users.id, op.user.id));
  if (created.length === 0) {
    throw new UserCreateCollisionError(
      `Rails user ${op.railsUserId}: user ${op.user.id} was not created; refusing to write grants for it.`,
    );
  }
}

async function readUser(writer: Writer, userId: string) {
  const [row] = await writer
    .select({ id: users.id, email: users.email, legacyRailsUserId: users.legacyRailsUserId })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

async function linkUser(writer: Writer, op: Extract<DeltaOp, { kind: "user_link" }>) {
  await writer
    .update(users)
    .set({
      fields: sql`JSON_SET(COALESCE(${users.fields}, JSON_OBJECT()), '$.legacyRailsUserId', ${op.railsUserId}, '$.legacyRailsUserLinkedBy', 'rails_access_delta')`,
    })
    .where(and(eq(users.id, op.userId), isNull(users.legacyRailsUserId)));
  // The guard makes a raced link a silent no-op; the grants after it would land
  // on the wrong person. Re-read and fail the batch instead.
  const row = await readUser(writer, op.userId);
  if (row?.legacyRailsUserId !== op.railsUserId) {
    throw new UserWriteConflictError(
      `Rails user ${op.railsUserId}: user ${op.userId} ${row ? `is linked to Rails user ${row.legacyRailsUserId ?? "(none)"}` : "no longer exists"}. ` +
        "Nothing in this batch was written. Dry-run into a NEW --out folder, review it and --apply that plan; this partial apply is safe to leave.",
    );
  }
}

async function updateUserEmail(
  writer: Writer,
  op: Extract<DeltaOp, { kind: "user_email_update" }>,
) {
  const holders = await writer
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, op.email));
  const other = holders.find((holder) => holder.id !== op.userId);
  if (other) {
    throw new UserWriteConflictError(
      `Rails user ${op.railsUserId}: CourseBuilder user ${other.id} already holds the Rails email. ` +
        "Nothing in this batch was written. Dry-run into a NEW --out folder, review it and --apply that plan; this partial apply is safe to leave.",
    );
  }
  await writer
    .update(users)
    .set({ email: op.email })
    .where(
      and(
        eq(users.id, op.userId),
        eq(users.email, op.previousEmail),
        eq(users.legacyRailsUserId, op.railsUserId),
      ),
    );
  const row = await readUser(writer, op.userId);
  if (row?.email !== op.email || row.legacyRailsUserId !== op.railsUserId) {
    throw new UserWriteConflictError(
      `Rails user ${op.railsUserId}: user ${op.userId} changed since the plan; its email was not updated. ` +
        "Nothing in this batch was written. Dry-run into a NEW --out folder, review it and --apply that plan; this partial apply is safe to leave.",
    );
  }
}

async function writeOp(writer: Writer, op: DeltaOp, now: Date) {
  switch (op.kind) {
    case "user_create":
      return createUser(writer, op, now);
    case "user_link":
      return linkUser(writer, op);
    case "user_email_update":
      return updateUserEmail(writer, op);
    case "organization_create":
      await writer
        .insert(organization)
        .values({
          id: op.organization.id,
          name: op.organization.name,
          fields: op.organization.fields,
          createdAt: dateOrNull(op.organization.createdAt) ?? now,
        })
        .onDuplicateKeyUpdate({ set: { id: sql`${organization.id}` } });
      return;
    case "membership_create":
    case "membership_update":
      await writer
        .insert(organizationMemberships)
        .values({
          id: op.membership.id,
          organizationId: op.membership.organizationId,
          userId: op.membership.userId,
          invitedById: op.membership.invitedById,
          role: op.membership.role,
          fields: op.membership.fields,
          createdAt: dateOrNull(op.membership.createdAt) ?? now,
        })
        .onDuplicateKeyUpdate({
          set: {
            organizationId: sql`VALUES(${organizationMemberships.organizationId})`,
            userId: sql`VALUES(${organizationMemberships.userId})`,
            role: sql`VALUES(${organizationMemberships.role})`,
            fields: sql`JSON_REMOVE(JSON_MERGE_PATCH(COALESCE(${organizationMemberships.fields}, JSON_OBJECT()), VALUES(${organizationMemberships.fields})), '$.memberRoleClearedBy')`,
          },
        });
      return;
    case "membership_revoke":
      await writer
        .update(organizationMemberships)
        .set({
          fields: sql`JSON_SET(COALESCE(${organizationMemberships.fields}, JSON_OBJECT()), '$.hasAccountMemberRole', CAST('false' AS JSON), '$.memberRoleClearedBy', 'rails_access_delta')`,
        })
        .where(eq(organizationMemberships.id, op.membershipId));
      return;
    case "entitlement_grant":
    case "entitlement_extend":
    case "entitlement_update": {
      const row = op.entitlement;
      await writer
        .insert(entitlements)
        .values({
          id: row.id,
          entitlementType: row.entitlementType,
          userId: row.userId,
          organizationId: row.organizationId,
          organizationMembershipId: row.organizationMembershipId,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          metadata: row.metadata,
          expiresAt: dateOrNull(row.expiresAt),
          createdAt: dateOrNull(row.createdAt) ?? now,
          updatedAt: now,
          deletedAt: null,
        })
        .onDuplicateKeyUpdate({
          set: {
            entitlementType: sql`VALUES(${entitlements.entitlementType})`,
            userId: sql`VALUES(${entitlements.userId})`,
            organizationId: sql`VALUES(${entitlements.organizationId})`,
            organizationMembershipId: sql`VALUES(${entitlements.organizationMembershipId})`,
            sourceType: sql`VALUES(${entitlements.sourceType})`,
            sourceId: sql`VALUES(${entitlements.sourceId})`,
            metadata: sql`JSON_REMOVE(JSON_MERGE_PATCH(COALESCE(${entitlements.metadata}, JSON_OBJECT()), VALUES(${entitlements.metadata})), '$.revokedBy', '$.revokedReason')`,
            expiresAt: sql`VALUES(${entitlements.expiresAt})`,
            updatedAt: sql`VALUES(${entitlements.updatedAt})`,
            deletedAt: null,
          },
        });
      return;
    }
    case "entitlement_revoke":
    case "entitlement_expire":
      await writer
        .update(entitlements)
        .set({
          deletedAt: now,
          updatedAt: now,
          metadata: sql`JSON_SET(COALESCE(${entitlements.metadata}, JSON_OBJECT()), '$.revokedBy', 'rails_access_delta', '$.revokedReason', ${op.kind === "entitlement_expire" ? "expired" : "not_granted_by_rails"})`,
        })
        .where(
          and(
            eq(entitlements.id, op.entitlementId),
            isNull(entitlements.deletedAt),
            inArray(entitlements.sourceType, OWNED),
          ),
        );
      return;
  }
}

export interface BatchTiming {
  readonly batch: number;
  readonly ops: number;
  /** Wall time of the batch transaction, commit included. */
  readonly ms: number;
  readonly lastKey: string | null;
}

export interface ApplyOptions {
  readonly batchSize: number;
  readonly undoRows?: readonly UndoRow[];
  /** Called after each committed batch, before the cursor is saved. */
  readonly onBatch?: (timing: BatchTiming) => void;
  /** Stop after this many committed batches (resume later). */
  readonly maxBatches?: number;
  readonly now: () => Date;
  /** Persist the cursor after every committed batch. */
  readonly saveCursor: (cursor: ApplyCursor) => Promise<void>;
}

/** Run one batch's writes in order inside its transaction. */
function writeInOrder(writer: Writer, batch: readonly DeltaOp[], now: Date) {
  return batch.reduce<Promise<void>>(
    (previous, op) => previous.then(() => writeOp(writer, op, now)),
    Promise.resolve(),
  );
}

async function applyBatches(
  db: EggheadDatabase,
  batches: readonly (readonly DeltaOp[])[],
  cursor: ApplyCursor,
  options: ApplyOptions,
  done = 0,
): Promise<ApplyCursor> {
  const batch = batches[done];
  if (!batch || (options.maxBatches !== undefined && done >= options.maxBatches)) return cursor;
  const now = options.now();
  const started = performance.now();
  let journal = cursor.undoRows ?? [];
  await db.transaction(async (transaction) => {
    const reviewed = options.undoRows
      ? undoForOps(options.undoRows, batch)
      : await captureUndo(transaction, batch);
    const previous = reviewed.map(
      (row) => journal.find((saved) => saved.table === row.table && saved.id === row.id) ?? row,
    );
    await checkUndoBaseline(transaction, previous);
    await writeInOrder(transaction, batch, now);
    const stamped = await stampUndo(transaction, previous);
    journal = [
      ...journal.filter(
        (row) => !stamped.some((next) => next.table === row.table && next.id === row.id),
      ),
      ...stamped,
    ];
    // Write proof before commit. If the process dies before commit, rollback
    // refuses a mismatching image; it never guesses that a write landed.
    await options.saveCursor({ ...cursor, undoRows: journal });
  });
  options.onBatch?.({
    batch: cursor.batches + 1,
    ops: batch.length,
    ms: Math.round(performance.now() - started),
    lastKey: batch.at(-1)?.key ?? null,
  });
  const appliedOps = cursor.appliedOps + batch.length;
  const next: ApplyCursor = {
    ...cursor,
    appliedOps,
    undoRows: journal,
    batches: cursor.batches + 1,
    lastKey: batch.at(-1)?.key ?? cursor.lastKey,
    complete: appliedOps >= cursor.totalOps,
    updatedAt: now.toISOString(),
  };
  await options.saveCursor(next);
  return applyBatches(db, batches, next, options, done + 1);
}

/**
 * Apply ops in key order from the cursor. Each batch commits in one transaction,
 * then the cursor advances. A crash between commit and cursor save replays that
 * batch, which is safe because every write is idempotent.
 */
export async function applyDeltaOps(
  db: EggheadDatabase,
  ops: readonly DeltaOp[],
  cursor: ApplyCursor,
  options: ApplyOptions,
): Promise<ApplyCursor> {
  const ordered = ops.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const lastKey = cursor.lastKey;
  const pending = lastKey === null ? ordered : ordered.filter((op) => op.key > lastKey);
  const result = await applyBatches(
    db,
    chunks(pending, Math.max(1, options.batchSize)),
    cursor,
    options,
  );
  if (pending.length > 0 || result.complete) return result;
  const finished = { ...result, complete: true, updatedAt: options.now().toISOString() };
  await options.saveCursor(finished);
  return finished;
}
