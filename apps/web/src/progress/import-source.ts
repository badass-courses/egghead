import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

/**
 * One line of the Rails progress export (`scripts/sql/rails-progress-export.sql`).
 * Each line holds one Rails user and every completion we import for them.
 */
const isoDateSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const railsLessonCompletionSchema = z.object({
  railsLessonId: z.number().int().positive(),
  slug: z.string().nullable(),
  completedAt: isoDateSchema.nullable(),
});

const railsSeriesCompletionSchema = z.object({
  railsPlaylistId: z.number().int().positive().nullable(),
  railsSeriesId: z.number().int().positive().nullable(),
  slug: z.string().nullable(),
  completedAt: isoDateSchema.nullable(),
});

export const railsUserProgressSchema = z.object({
  railsUserId: z.number().int().positive(),
  email: z.string().nullable(),
  lastActiveAt: isoDateSchema.nullable(),
  lessons: z.array(railsLessonCompletionSchema),
  series: z.array(railsSeriesCompletionSchema),
});

export type RailsLessonCompletion = z.output<typeof railsLessonCompletionSchema>;
export type RailsSeriesCompletion = z.output<typeof railsSeriesCompletionSchema>;
export type RailsUserProgress = z.output<typeof railsUserProgressSchema>;

export function normalizeEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

/**
 * Where Rails progress comes from. The bulk import walks `users` in Rails user
 * id order; the on-demand path asks `findUser` for one learner.
 */
export type RailsProgressSource = {
  readonly description: string;
  /** Users with `railsUserId > afterRailsUserId`, ascending by Rails user id. */
  users(input: { afterRailsUserId: number }): AsyncIterable<RailsUserProgress>;
  /** One user's progress, matched by Rails user id first, then normalized email. */
  findUser(input: {
    railsUserId: number | null;
    email: string | null;
  }): Promise<RailsUserProgress | null>;
  /**
   * Normalized email → the lowest Rails user id carrying it, across the whole
   * source. Rails emails are unique, but trimming and lower-casing can make two
   * accounts collide; only the lowest id may then match a CB user by email, so
   * the outcome does not depend on batch boundaries.
   */
  emailOwners(): Promise<ReadonlyMap<string, number>>;
};

async function lowestIdPerEmail(
  users: AsyncIterable<RailsUserProgress> | Iterable<RailsUserProgress>,
) {
  const owners = new Map<string, number>();
  for await (const user of users) {
    const email = normalizeEmail(user.email);
    if (email === null) continue;
    const owner = owners.get(email);
    if (owner === undefined || user.railsUserId < owner) owners.set(email, user.railsUserId);
  }
  return owners;
}

export function parseRailsProgressLine(line: string, lineNumber: number): RailsUserProgress {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`Rails progress export line ${lineNumber} is not JSON`);
  }

  const parsed = railsUserProgressSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Rails progress export line ${lineNumber} does not match the export shape: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

/**
 * An id match always beats an email match, wherever the two sit in the
 * export: the email row is only remembered until the scan ends.
 */
async function findUserIdFirst(
  users: AsyncIterable<RailsUserProgress> | Iterable<RailsUserProgress>,
  input: { railsUserId: number | null; email: string | null },
) {
  const email = normalizeEmail(input.email);
  let emailMatch: RailsUserProgress | null = null;

  for await (const user of users) {
    if (input.railsUserId !== null && user.railsUserId === input.railsUserId) return user;
    if (emailMatch === null && email !== null && normalizeEmail(user.email) === email) {
      emailMatch = user;
    }
  }

  return emailMatch;
}

async function* readJsonlUsers(path: string) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  let previousRailsUserId = 0;

  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;

      const user = parseRailsProgressLine(line, lineNumber);
      // The resume cursor is a Rails user id, so a shuffled export would skip
      // users silently on resume. Refuse it instead.
      if (user.railsUserId <= previousRailsUserId) {
        throw new Error(
          `Rails progress export is not sorted by railsUserId at line ${lineNumber} (${user.railsUserId} after ${previousRailsUserId})`,
        );
      }
      previousRailsUserId = user.railsUserId;
      yield user;
    }
  } finally {
    lines.close();
  }
}

/**
 * Reads the JSONL export from disk. `findUser` scans the whole file, which is
 * fine for the desk and for tests, but too slow for a sign-in hook. The
 * production on-demand path needs an indexed store (for example the export
 * loaded into a staging table) behind this same interface.
 */
export function jsonlRailsProgressSource(path: string): RailsProgressSource {
  return {
    description: `jsonl:${path}`,
    async *users({ afterRailsUserId }) {
      for await (const user of readJsonlUsers(path)) {
        if (user.railsUserId > afterRailsUserId) yield user;
      }
    },
    findUser(input) {
      return findUserIdFirst(readJsonlUsers(path), input);
    },
    emailOwners() {
      return lowestIdPerEmail(readJsonlUsers(path));
    },
  };
}

export function memoryRailsProgressSource(
  users: readonly RailsUserProgress[],
  description = "memory",
): RailsProgressSource {
  const sorted = users.toSorted((left, right) => left.railsUserId - right.railsUserId);

  return {
    description,
    async *users({ afterRailsUserId }) {
      for (const user of sorted) {
        if (user.railsUserId > afterRailsUserId) yield user;
      }
    },
    findUser(input) {
      return findUserIdFirst(sorted, input);
    },
    emailOwners() {
      return lowestIdPerEmail(sorted);
    },
  };
}
