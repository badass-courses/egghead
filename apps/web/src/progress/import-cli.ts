import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * File formats the progress import CLI reads and writes, kept here so they
 * are tested without a database.
 */

export const importCursorSchema = z.object({
  /** One logical import has one runId; resume reuses it. */
  runId: z.string().min(1),
  lastRailsUserId: z.number().int().nonnegative(),
  source: z.string(),
  sourceSha256: z.string(),
  updatedAt: z.string(),
});
export type ImportCursor = z.infer<typeof importCursorSchema>;

export const rollbackScopeSchema = z.enum(["manifest", "table_scan"]);
export type RollbackScope = z.infer<typeof rollbackScopeSchema>;

export const rollbackCursorSchema = z.object({
  runId: z.string().min(1),
  /**
   * Manifest mode orders user ids in JavaScript; the table walk orders them by
   * the column's MySQL collation. A cursor only resumes the mode that wrote it.
   */
  scope: rollbackScopeSchema,
  lastUserId: z.string(),
  updatedAt: z.string(),
});
export type RollbackCursor = z.infer<typeof rollbackCursorSchema>;

/**
 * The database a connection reaches. The user and port are part of it: on
 * PlanetScale every branch of a database shares one host and database name,
 * and the branch-specific credentials pick the branch.
 */
export type ProgressImportIdentity = {
  runtime: string;
  host: string;
  port: number;
  user: string;
  database: string;
};

/**
 * Which database a receipt was made against: the runtime, plus a hash of the
 * full identity with a random per-receipt salt. The receipt never carries the
 * host or user, and the salt stops a list of likely hosts from reversing the
 * hash.
 */
export const progressImportTargetSchema = z.object({
  runtime: z.string(),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  identityHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ProgressImportTarget = z.infer<typeof progressImportTargetSchema>;

function identityHash(identity: ProgressImportIdentity, salt: string) {
  return createHash("sha256")
    .update(
      [
        salt,
        identity.runtime,
        identity.host.toLowerCase(),
        String(identity.port),
        identity.user,
        identity.database,
      ].join("\u0000"),
    )
    .digest("hex");
}

export function progressImportTarget(
  identity: ProgressImportIdentity,
  salt = randomBytes(16).toString("hex"),
): ProgressImportTarget {
  return { runtime: identity.runtime, salt, identityHash: identityHash(identity, salt) };
}

export function targetMatches(target: ProgressImportTarget, identity: ProgressImportIdentity) {
  return (
    target.runtime === identity.runtime &&
    target.identityHash === identityHash(identity, target.salt)
  );
}

/** What the import CLI writes as its receipt and prints: the dry run's proof for `--apply`. */
export function importOutput<Receipt>(input: {
  identity: ProgressImportIdentity;
  sourceSha256: string;
  receipt: Receipt;
}) {
  return {
    target: progressImportTarget(input.identity),
    sourceSha256: input.sourceSha256,
    receipt: input.receipt,
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON. Fix or move it; nothing was written.`);
  }
}

export function parseImportCursor(text: string, what = "Cursor file"): ImportCursor {
  const parsed = importCursorSchema.safeParse(parseJson(text, what));
  if (!parsed.success) {
    throw new Error(`${what} is not a progress import cursor. Nothing was written.`);
  }
  return parsed.data;
}

export function parseRollbackCursor(text: string, what = "Rollback cursor"): RollbackCursor {
  const parsed = rollbackCursorSchema.safeParse(parseJson(text, what));
  if (!parsed.success) {
    throw new Error(`${what} is not a progress rollback cursor. Nothing was written.`);
  }
  return parsed.data;
}

/** A rollback cursor resumes only the run and the mode (manifest or table walk) that wrote it. */
export function assertRollbackCursorFits(
  cursor: RollbackCursor,
  expected: { runId: string; scope: RollbackScope },
) {
  if (cursor.runId !== expected.runId) {
    throw new Error(`Rollback cursor belongs to run ${cursor.runId}, not ${expected.runId}.`);
  }
  if (cursor.scope !== expected.scope) {
    throw new Error(
      `Rollback cursor was written by a ${cursor.scope} rollback, and this one is ${expected.scope}; their user orders differ. Resume with the same mode or start a new cursor.`,
    );
  }
}

/**
 * Where an import starts: a fresh run, or the cursor's run and position. The
 * cursor must belong to this export, and `--after` cannot also be given.
 */
export function resolveImportStart(input: {
  cursorGiven: boolean;
  cursor: ImportCursor | null;
  after: number | undefined;
  sourceSha256: string;
}) {
  if (input.cursorGiven && input.after !== undefined) {
    throw new Error(
      "Use --cursor or --after, not both: the cursor already records where to resume.",
    );
  }
  if (input.cursor && input.cursor.sourceSha256 !== input.sourceSha256) {
    throw new Error(
      `Cursor belongs to a different export (sha256 ${input.cursor.sourceSha256.slice(0, 12)}…, this file ${input.sourceSha256.slice(0, 12)}…). Use a new cursor file per export.`,
    );
  }
  return {
    runId: input.cursor?.runId ?? null,
    afterRailsUserId: input.after ?? input.cursor?.lastRailsUserId ?? 0,
  };
}

const manifestLineSchema = z.object({ runId: z.string(), cbUserIds: z.array(z.string()) });

/** The CB user ids a run wrote, from the JSONL manifest the CLI appends before each write. */
export function manifestUserIds(text: string, runId: string) {
  const userIds = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const parsed = manifestLineSchema.safeParse(parseJson(line, `Manifest line ${index + 1}`));
    if (!parsed.success) throw new Error(`Manifest line ${index + 1} is not a manifest entry`);
    if (parsed.data.runId !== runId) continue;
    for (const userId of parsed.data.cbUserIds) userIds.add(userId);
  }
  return [...userIds];
}

const dryRunReceiptSchema = z.object({
  sourceSha256: z.string(),
  target: progressImportTargetSchema,
  receipt: z.object({
    mode: z.literal("dry_run"),
    fullSource: z.literal(true),
    finishedAt: z.string(),
  }),
});

/**
 * `--apply` needs a finished dry run over the whole file with the same sha256,
 * against the same database, so a malformed or unsorted line late in the file
 * fails the dry run instead of stopping a half-written apply, and a local dry
 * run cannot unlock a beta write. It proves the counts were produced, not that
 * someone read them, and a hand-written file can still pass.
 */
export function assertDryRunReceiptMatches(
  text: string,
  sourceSha256: string,
  identity: ProgressImportIdentity,
) {
  const parsed = dryRunReceiptSchema.safeParse(parseJson(text, "Dry-run receipt"));
  if (!parsed.success) {
    throw new Error(
      "The --expect-dry-run receipt is not a finished full-file dry run (mode dry_run, fullSource true, with a salted target). Receipts from before the salted target are refused. Run the dry run over the whole file first.",
    );
  }
  if (!targetMatches(parsed.data.target, identity)) {
    throw new Error(
      `The --expect-dry-run receipt was made against another database or branch (runtime ${parsed.data.target.runtime}), not this connection (runtime ${identity.runtime}, same host, port, user and database required). Dry-run this target first.`,
    );
  }
  if (parsed.data.sourceSha256 !== sourceSha256) {
    throw new Error(
      `The --expect-dry-run receipt was for a different export (sha256 ${parsed.data.sourceSha256.slice(0, 12)}…, this file ${sourceSha256.slice(0, 12)}…).`,
    );
  }
}
