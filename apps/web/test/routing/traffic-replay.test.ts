// Traffic replay: real egghead.io GET paths (fixtures/egghead-top-paths.txt,
// query strings stripped, highest traffic first, from a 7-day Vercel log pull
// on 2026-11-19) walked through the rule table and the app route tree.
//
// Every path must be redirected, retired, owned by a build row, or answered by
// an app route. The test prints the class of each path family and the paths
// owned by build rows, in traffic order. It cannot see whether content exists
// behind a dynamic route; the report checks the top paths against the beta
// sitemap.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ROUTE_INVENTORY } from "../../src/routing/route-inventory";
import {
  beforeFilesRewrites,
  firstMatch,
  matchesPattern,
  redirectIdFor,
  redirects,
  resolveAppRoute,
} from "./route-table";

const fixture = await readFile(
  new URL("./fixtures/egghead-top-paths.txt", import.meta.url),
  "utf8",
);
const paths = fixture.split("\n").filter(Boolean);

// Build rows carry an egghead-next pattern such as /i/[slug]/rss.xml or
// /courses/:id/course_feed; normalize to a path-to-regexp source.
function buildRowSource(legacy: string) {
  return legacy
    .replaceAll(/\[\[\.\.\.([^\]]+)\]\]/g, ":$1*")
    .replaceAll(/\[\.\.\.([^\]]+)\]/g, ":$1+")
    .replaceAll(/\[([^\]]+)\]/g, ":$1");
}

const buildPatterns = ROUTE_INVENTORY.flatMap((row) =>
  row.disposition.class === "build"
    ? [{ source: buildRowSource(row.legacy), lane: row.disposition.lane }]
    : [],
);

type Outcome =
  | { kind: "redirect"; rule: string; destination: string }
  | { kind: "retire"; rule: string }
  | { kind: "build"; lane: string }
  | { kind: "served"; route: string }
  | { kind: "unrouted" };

function classify(pathname: string): Outcome {
  const redirect = firstMatch(redirects, pathname);
  if (redirect) {
    return {
      kind: "redirect",
      rule: redirectIdFor(redirect.rule) ?? redirect.rule.source,
      destination: redirect.destination,
    };
  }
  const retired = firstMatch(beforeFilesRewrites, pathname);
  if (retired) return { kind: "retire", rule: retired.destination.split("/").at(-1) ?? "" };
  const owner = buildPatterns.find(({ source }) => matchesPattern(source, pathname));
  if (owner) return { kind: "build", lane: owner.lane };
  const route = resolveAppRoute(pathname);
  return route ? { kind: "served", route } : { kind: "unrouted" };
}

const outcomes = paths.map((pathname, rank) => ({
  pathname,
  rank: rank + 1,
  ...classify(pathname),
}));

void test("every replayed path is routed on purpose", () => {
  const unrouted = outcomes.filter((outcome) => outcome.kind === "unrouted");
  assert.deepEqual(
    unrouted.map(({ rank, pathname }) => `#${rank} ${pathname}`),
    [],
  );
});

void test("redirected paths land on an app route", () => {
  const dead = outcomes.flatMap((outcome) =>
    outcome.kind === "redirect" && !resolveAppRoute(outcome.destination)
      ? [`#${outcome.rank} ${outcome.pathname} -> ${outcome.destination}`]
      : [],
  );
  assert.deepEqual(dead, []);
});

void test("summary", () => {
  const byKind = new Map<string, number>();
  const byRoute = new Map<string, number>();
  for (const outcome of outcomes) {
    byKind.set(outcome.kind, (byKind.get(outcome.kind) ?? 0) + 1);
    const key =
      outcome.kind === "served"
        ? `served ${outcome.route}`
        : outcome.kind === "redirect"
          ? `redirect ${outcome.rule}`
          : outcome.kind === "retire"
            ? `retire ${outcome.rule}`
            : outcome.kind === "build"
              ? `build ${outcome.lane}`
              : "unrouted";
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  }
  const buildOwned = outcomes
    .filter((outcome) => outcome.kind === "build")
    .slice(0, 25)
    .map(({ rank, pathname }) => `#${rank} ${pathname}`);
  console.log(
    JSON.stringify({
      trafficReplay: {
        paths: outcomes.length,
        byKind: Object.fromEntries(byKind),
        byRoute: Object.fromEntries([...byRoute].toSorted((a, b) => b[1] - a[1])),
        buildOwned,
      },
    }),
  );
  assert.equal(outcomes.length, paths.length);
});
