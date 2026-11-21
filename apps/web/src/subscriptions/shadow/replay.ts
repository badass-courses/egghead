import { pathToFileURL } from "node:url";
import { dispatchShadowEvent, type ShadowDependencies } from "./handler";
import { shadowDependencies } from "./configuration";

/** Stripe retains events for ~30 days. The supplied window is [from, to), epoch seconds. */
export async function replayShadowWindow(from: number, to: number, deps: ShadowDependencies) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    throw new Error("Use a positive [from, to) window in epoch seconds");
  const counts = { recorded: 0, duplicate: 0, ignored: 0 };
  for await (const event of deps.stripe.events(from, to)) {
    const result = await dispatchShadowEvent(event, deps);
    counts[result.status] += 1;
  }
  return counts;
}

async function main() {
  const [from, to] = process.argv.slice(2).map(Number);
  if (from === undefined || to === undefined || process.argv.length !== 4)
    throw new Error("Usage: replay.ts <from-epoch-seconds> <to-epoch-seconds>");
  const counts = await replayShadowWindow(from, to, shadowDependencies(process.env));
  console.error(JSON.stringify({ name: "subscription.shadow.replay-complete", ...counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Shadow replay failed; check isolated configuration and window. No payloads logged.",
    );
    process.exitCode = 1;
  });
}
