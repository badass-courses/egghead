// Feed GUID parity against a saved Rails feed (judge #9). Read-only.
//
//   EGGHEAD_RUNTIME=beta EGGHEAD_BETA_DB_APPROVED=true DATABASE_URL=<injected> \
//     pnpm feeds:parity --rails <saved-feed.xml> --feed <feed> [--json] [--statement-guard-only]
//
// Feeds:
// - `--feed lessons`: /feed and /lessons/feed (Rails served identical bytes).
// - `--feed pro [--tech react,node]`: lessons#pro_feed, optionally filtered.
// - `--feed course --param <id or slug>`: courses#course_feed.
// - `--feed playlist --param <id or slug>`: playlists#playlist_feed.
// Save the Rails member feeds with any member's feed token; the saved file
// holds no token, and this script never reads one.
//
// It runs the shipped CB reader and builder against the database, then
// compares GUIDs with the saved Rails feed:
// - Rails items published after the database's newest content row go in a
//   "newer than snapshot" bucket and are not counted as misses;
// - each miss gets a reason looked up from the CB row for that slug.
//
// Safety: every connection runs `SET SESSION TRANSACTION READ ONLY`, and the
// connection factory refuses any statement that is not SELECT, SHOW, WITH or
// EXPLAIN before sending it (EGGHEAD_DB_READ_ONLY in
// apps/web/src/db/local-docker.ts). If the server rejects the SET, the script
// stops; `--statement-guard-only` keeps just the statement check. Output holds
// GUIDs, titles, dates and content states only: no emails, users or secrets.

import { readFileSync } from "node:fs";

import type { ParityTarget } from "../apps/web/src/feeds/parity-run";

type Args = { rails: string; target: ParityTarget; json: boolean; guardOnly: boolean };

function targetFrom(feed: string | null, tech: string | null, param: string | null): ParityTarget {
  if (feed === "lessons") return { feed };
  if (feed === "pro") {
    const tags = (tech ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    return { feed, tech: tags };
  }
  if (feed === "course" || feed === "playlist") {
    if (!param) throw new Error(`Pass --param <id or slug> with --feed ${feed}.`);
    return { feed, param };
  }
  throw new Error("Pass --feed lessons, pro, course or playlist.");
}

function parseArgs(argv: readonly string[]): Args {
  const rest = [...argv];
  let rails: string | null = null;
  let feed: string | null = null;
  let tech: string | null = null;
  let param: string | null = null;
  let json = false;
  let guardOnly = false;
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--rails") rails = rest.shift() ?? null;
    else if (arg === "--feed") feed = rest.shift() ?? null;
    else if (arg === "--tech") tech = rest.shift() ?? null;
    else if (arg === "--param") param = rest.shift() ?? null;
    else if (arg === "--json") json = true;
    else if (arg === "--statement-guard-only") guardOnly = true;
    else if (arg !== "--") throw new Error(`Unknown argument: ${arg ?? ""}`);
  }
  if (!rails) throw new Error("Pass --rails <saved Rails feed XML>.");
  return { rails, target: targetFrom(feed, tech, param), json, guardOnly };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Set before any app module opens a connection.
  process.env["EGGHEAD_DB_READ_ONLY"] = args.guardOnly ? "guard" : "session";

  const { formatParityReport, parseFeedItems } = await import("../apps/web/src/feeds/parity");
  const { runFeedParity } = await import("../apps/web/src/feeds/parity-run");

  const rails = parseFeedItems(readFileSync(args.rails, "utf8"));
  const result = await runFeedParity(rails, args.target);
  const label =
    args.target.feed === "pro"
      ? `pro${args.target.tech.length > 0 ? ` (tech ${args.target.tech.join(",")})` : ""}`
      : args.target.feed === "lessons"
        ? "lessons"
        : `${args.target.feed} ${args.target.param}`;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          feed: label,
          runtime: result.runtime,
          readOnly: result.readOnly,
          snapshotNewest: result.snapshotNewest,
          duplicates: result.duplicates,
          ...result.diff,
          reasons: Object.fromEntries(result.reasons),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`runtime ${result.runtime}, read-only mode ${result.readOnly}`);
  process.stdout.write(
    formatParityReport(
      label,
      result.diff,
      result.reasons,
      result.snapshotNewest,
      result.duplicates,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
