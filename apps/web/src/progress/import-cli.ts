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

export const rollbackCursorSchema = z.object({
  runId: z.string().min(1),
  lastUserId: z.string(),
  updatedAt: z.string(),
});
export type RollbackCursor = z.infer<typeof rollbackCursorSchema>;

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
  receipt: z.object({
    mode: z.literal("dry_run"),
    fullSource: z.literal(true),
    finishedAt: z.string(),
  }),
});

/**
 * `--apply` needs a finished dry run over the whole file with the same sha256,
 * so a malformed or unsorted line late in the file fails the dry run instead
 * of stopping a half-written apply.
 */
export function assertDryRunReceiptMatches(text: string, sourceSha256: string) {
  const parsed = dryRunReceiptSchema.safeParse(parseJson(text, "Dry-run receipt"));
  if (!parsed.success) {
    throw new Error(
      "The --expect-dry-run receipt is not a finished full-file dry run (mode dry_run, fullSource true). Run the dry run over the whole file first.",
    );
  }
  if (parsed.data.sourceSha256 !== sourceSha256) {
    throw new Error(
      `The --expect-dry-run receipt was for a different export (sha256 ${parsed.data.sourceSha256.slice(0, 12)}…, this file ${sourceSha256.slice(0, 12)}…).`,
    );
  }
}
