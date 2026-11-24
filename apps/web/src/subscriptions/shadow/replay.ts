import { pathToFileURL } from "node:url";
import { z } from "zod";
import { shadowDependencies } from "./configuration";
import { dispatchShadowEvent, type ShadowDependencies } from "./handler";
import { SHADOW_STRIPE_EVENTS, shadowEventSchema, type ShadowEvent } from "./projection";
import { MemoryShadowStore } from "./store";
import {
  createShadowStripeEventsReader,
  createShadowStripeReader,
  ShadowStripeScopeError,
} from "./stripe-reader";

const eventType = z.object({
  type: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
    .max(100),
});
const supportedTypes = new Set<string>(SHADOW_STRIPE_EVENTS);
const typeCounts = () => ({
  listed: 0,
  unsupported: 0,
  eventParseFailures: 0,
  projectionParseFailures: 0,
  processingFailures: 0,
  duplicate: 0,
  wouldDo: 0,
  skipped: 0,
  tenantMetadataConflicts: 0,
  unresolvedDeletedCustomers: 0,
});

type ReplayMode =
  | { mode: "--events-only"; stripe: Pick<ShadowDependencies["stripe"], "events"> }
  | { mode: "--dry-run"; stripe: ShadowDependencies["stripe"] }
  | { mode: "--write-shadow"; deps: ShadowDependencies };

/** Stripe retains events for ~30 days. The supplied window is [from, to), epoch seconds. */
export async function replayShadowWindow(input: { from: number; to: number } & ReplayMode) {
  const { from, to, mode } = input;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    throw new Error("Use a nonnegative [from, to) window in epoch seconds");
  const stripe = input.mode === "--write-shadow" ? input.deps.stripe : input.stripe;
  const deps =
    input.mode === "--write-shadow"
      ? input.deps
      : input.mode === "--dry-run"
        ? { stripe: input.stripe, store: new MemoryShadowStore(), log: () => {} }
        : null;
  const byType = new Map<string, ReturnType<typeof typeCounts>>();
  const countsFor = (type: string) => {
    const counts = byType.get(type) ?? typeCounts();
    byType.set(type, counts);
    return counts;
  };

  // Stripe returns newest-first pages. Collect before dispatch so ordering spans pages.
  const events: ShadowEvent[] = [];
  for await (const raw of stripe.events(from, to)) {
    const envelope = eventType.safeParse(raw);
    const type = envelope.success ? envelope.data.type : "invalid-type";
    const counts = countsFor(type);
    counts.listed += 1;
    if (envelope.success && !supportedTypes.has(type)) {
      counts.unsupported += 1;
      continue;
    }
    const parsed = shadowEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.created < from || parsed.data.created >= to) {
      counts.eventParseFailures += 1;
      continue;
    }
    if (deps) events.push(parsed.data);
  }
  const ordered = events.toSorted((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  await ordered.reduce(async (previous, event) => {
    await previous; // Complete each claim/projection before dispatching the next event.
    if (!deps) throw new Error("Events-only replay cannot dispatch");
    const counts = countsFor(event.type);
    try {
      const result = await dispatchShadowEvent(event, deps);
      if (result.status === "duplicate") counts.duplicate += 1;
      if (result.status === "recorded") {
        const { record } = result;
        if (record.name === "subscription.shadow.would-do") counts.wouldDo += 1;
        else counts.skipped += 1;
        counts.tenantMetadataConflicts += record.tenantMetadataConflicts;
        counts.unresolvedDeletedCustomers += record.unresolvedDeletedCustomers;
      }
    } catch (error) {
      if (error instanceof ShadowStripeScopeError) throw error;
      if (error instanceof z.ZodError) counts.projectionParseFailures += 1;
      else if (mode === "--dry-run") counts.processingFailures += 1;
      else throw error; // A write or read failure must not quietly leave gaps in a backfill.
    }
  }, Promise.resolve());
  return {
    from,
    to,
    mode,
    projectionExecuted: deps !== null,
    failures: [...byType.values()].reduce(
      (sum, c) => sum + c.eventParseFailures + c.projectionParseFailures + c.processingFailures,
      0,
    ),
    byType: Object.fromEntries(
      [...byType.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([type, counts]) => [
          type,
          deps
            ? counts
            : {
                listed: counts.listed,
                unsupported: counts.unsupported,
                eventParseFailures: counts.eventParseFailures,
                projectionParseFailures: null,
                processingFailures: null,
              },
        ]),
    ),
  };
}

export async function runShadowReplayCommand({
  args,
  env,
  request = fetch,
}: {
  args: string[];
  env: Readonly<Record<string, string | undefined>>;
  request?: typeof fetch;
}) {
  const [mode, rawFrom, rawTo] = args;
  if (
    args.length !== 3 ||
    (mode !== "--events-only" && mode !== "--dry-run" && mode !== "--write-shadow") ||
    !rawFrom ||
    !rawTo ||
    !/^\d+$/.test(rawFrom) ||
    !/^\d+$/.test(rawTo)
  )
    throw new Error(
      "Usage: replay.ts (--events-only | --dry-run | --write-shadow) <from-epoch-seconds> <to-epoch-seconds>",
    );
  const window = { from: Number(rawFrom), to: Number(rawTo) };
  if (mode === "--write-shadow") {
    // Replay prints counts only. The canonical records go to the isolated store.
    return replayShadowWindow({
      ...window,
      mode,
      deps: { ...shadowDependencies(env), log: () => {} },
    });
  }
  // Dry mode never reads a DB URL or constructs a database store, even if one is configured.
  const key = env["STRIPE_SHADOW_READ_KEY"];
  if (!key?.startsWith("rk_")) throw new Error("Restricted Stripe key required");
  return mode === "--events-only"
    ? replayShadowWindow({ ...window, mode, stripe: createShadowStripeEventsReader(key, request) })
    : replayShadowWindow({ ...window, mode, stripe: createShadowStripeReader(key, request) });
}

async function main() {
  const summary = await runShadowReplayCommand({ args: process.argv.slice(2), env: process.env });
  console.info(JSON.stringify(summary));
  if (summary.failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ShadowStripeScopeError) console.error(error.message);
    else
      console.error(
        "Shadow replay failed. Use (--events-only | --dry-run | --write-shadow) <from-epoch-seconds> <to-epoch-seconds>; check the Stripe read key, window, and, for write mode only, isolated shadow configuration. No payloads logged.",
      );
    process.exitCode = 1;
  });
}
