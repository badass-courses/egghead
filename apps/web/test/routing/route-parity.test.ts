// Route parity contract for the egghead.io domain flip.
//
// Walks src/routing/route-inventory.ts against the real Next config (loaded
// and validated by Next itself) and the app route tree on disk:
// - served rows resolve to the named app route, with no redirect or retire
//   rule in front of them;
// - redirect rows hit their named rule first and land on a path an app route
//   answers;
// - retire rows hit their named rule and the handler answers 410;
// - build rows are untouched by this lane's rules, so their owners get a
//   clean URL.
// It fails when a route file goes missing, a rule is reordered into the wrong
// match, or a rule exists that no inventory row explains.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { z } from "zod";

import { GET as retiredGet } from "../../src/app/api/retired/[rule]/route";
import {
  LEGACY_REDIRECTS,
  RETIRED_ROUTE_HANDLER_PREFIX,
  RETIRED_ROUTES,
  retiredRouteDestination,
} from "../../src/routing/legacy-redirects";
import {
  ROUTE_INVENTORY,
  routeInventoryCounts,
  type RouteInventoryRow,
} from "../../src/routing/route-inventory";
import { headingAnchor } from "../../src/static-pages/heading-anchor";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const appDir = path.join(webRoot, "src", "app");

type Rule = { source: string; destination: string };
type RuleHit = { rule: Rule; destination: string };

const ROUTE_FILE = /^(page\.tsx|route\.ts)$/;
const METADATA_ROUTES: Record<string, string> = {
  "robots.ts": "/robots.txt",
  "sitemap.ts": "/sitemap.xml",
};

async function appRoutePaths(dir: string, segments: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        return appRoutePaths(
          path.join(dir, entry.name),
          isGroup ? segments : [...segments, entry.name],
        );
      }
      if (ROUTE_FILE.test(entry.name)) return [`/${segments.join("/")}`];
      const metadataRoute = segments.length === 0 ? METADATA_ROUTES[entry.name] : undefined;
      return metadataRoute ? [metadataRoute] : [];
    }),
  );
  return nested.flat();
}

// Next loads next.config.ts the way `next build` does, in a plain Node child.
// Under the tsx loader Next's own require hook cannot resolve the config's
// TypeScript imports, so loading it in-process would test the wrong thing.
const LOAD_ROUTES_SCRIPT = `
const { default: loadConfig } = require("next/dist/server/config");
const { default: loadCustomRoutes } = require("next/dist/lib/load-custom-routes");
loadConfig(${JSON.stringify(PHASE_PRODUCTION_BUILD)}, process.cwd())
  .then(loadCustomRoutes)
  .then((routes) => process.stdout.write(JSON.stringify(routes)));
`;

const customRoutesSchema = z.object({
  redirects: z.array(
    z.object({ source: z.string(), destination: z.string(), internal: z.boolean().optional() }),
  ),
  rewrites: z.object({
    beforeFiles: z.array(z.object({ source: z.string(), destination: z.string() })),
  }),
});

async function loadNextCustomRoutes() {
  // An empty NODE_OPTIONS keeps any inherited loader flags out of the child.
  const env = { ...process.env, NODE_OPTIONS: "" };
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", LOAD_ROUTES_SCRIPT], {
    cwd: webRoot,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return customRoutesSchema.parse(JSON.parse(stdout));
}

const customRoutes = await loadNextCustomRoutes();
const redirects: Rule[] = customRoutes.redirects.filter((route) => route.internal !== true);
const beforeFilesRewrites: Rule[] = customRoutes.rewrites.beforeFiles;
const routeTable = getSortedRoutes(await appRoutePaths(appDir)).map((route) => ({
  route,
  re: getRouteRegex(route).re,
}));

function pathnameOf(url: string) {
  return new URL(url, "https://egghead.io").pathname;
}

function resolveAppRoute(url: string) {
  const pathname = pathnameOf(url);
  return routeTable.find(({ re }) => re.test(pathname))?.route;
}

function firstMatch(rules: readonly Rule[], url: string): RuleHit | undefined {
  const pathname = pathnameOf(url);
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (params === false) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query: {},
    });
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parsedDestination.query)) {
      for (const item of [value ?? []].flat()) search.append(key, item);
    }
    const query = search.size > 0 ? `?${search}` : "";
    return { rule, destination: `${parsedDestination.pathname}${query}` };
  }
  return undefined;
}

function redirectIdFor(rule: Rule) {
  return LEGACY_REDIRECTS.find((candidate) => candidate.source === rule.source)?.id;
}

function label(row: RouteInventoryRow) {
  return `${row.legacy} (${row.origin}, sample ${row.sample})`;
}

void describe("route inventory", () => {
  void test("every legacy path pattern appears once per origin", () => {
    const seen = new Set<string>();
    for (const row of ROUTE_INVENTORY) {
      const key = `${row.origin} ${row.legacy}`;
      assert.ok(!seen.has(key), `duplicate inventory row ${key}`);
      seen.add(key);
    }
  });

  void test("counts cover every row", () => {
    const counts = routeInventoryCounts();
    const classTotal = Object.values(counts.byClass).reduce((sum, count) => sum + count, 0);
    assert.equal(classTotal, counts.total);
    console.log(JSON.stringify({ routeInventory: counts }));
  });
});

void describe("served rows resolve in the CourseBuilder app", () => {
  for (const row of ROUTE_INVENTORY) {
    const { disposition } = row;
    if (disposition.class !== "served") continue;
    void test(label(row), () => {
      assert.equal(firstMatch(redirects, row.sample), undefined, "a redirect shadows it");
      assert.equal(
        firstMatch(beforeFilesRewrites, row.sample),
        undefined,
        "a retire rule shadows it",
      );
      assert.equal(resolveAppRoute(row.sample), disposition.cbRoute);
    });
  }
});

void describe("redirect rows hit their rule and land on an app route", () => {
  for (const row of ROUTE_INVENTORY) {
    const { disposition } = row;
    if (disposition.class !== "redirect") continue;
    void test(label(row), () => {
      const hit = firstMatch(redirects, row.sample);
      assert.ok(hit, "no redirect matches");
      assert.equal(redirectIdFor(hit.rule), disposition.rule, "a different rule matches first");
      assert.equal(hit.destination, disposition.destination);
      assert.equal(
        firstMatch(redirects, hit.destination),
        undefined,
        "destination redirects again",
      );
      assert.equal(
        firstMatch(beforeFilesRewrites, hit.destination),
        undefined,
        "destination is retired",
      );
      assert.ok(resolveAppRoute(hit.destination), `no app route answers ${hit.destination}`);
    });
  }
});

void describe("retire rows answer 410 with a reason", () => {
  for (const row of ROUTE_INVENTORY) {
    const { disposition } = row;
    if (disposition.class !== "retire") continue;
    void test(label(row), async () => {
      assert.equal(firstMatch(redirects, row.sample), undefined, "a redirect matches first");
      const hit = firstMatch(beforeFilesRewrites, row.sample);
      assert.ok(hit, "no retire rule matches");
      assert.equal(hit.destination, retiredRouteDestination(disposition.rule));
      assert.equal(resolveAppRoute(hit.destination), `${RETIRED_ROUTE_HANDLER_PREFIX}/[rule]`);
      const response = await retiredGet(new Request(`https://egghead.io${row.sample}`), {
        params: Promise.resolve({ rule: disposition.rule }),
      });
      assert.equal(response.status, 410);
      assert.equal(response.headers.get("x-egghead-retired-route"), disposition.rule);
    });
  }
});

void describe("build rows stay free for their follow-up lanes", () => {
  for (const row of ROUTE_INVENTORY) {
    const { disposition } = row;
    if (disposition.class !== "build") continue;
    void test(`${label(row)} -> ${disposition.lane}`, () => {
      assert.equal(firstMatch(redirects, row.sample), undefined, "a redirect captures it");
      assert.equal(
        firstMatch(beforeFilesRewrites, row.sample),
        undefined,
        "a retire rule captures it",
      );
    });
  }
});

void describe("rule table", () => {
  void test("Next loads exactly the table, in order", () => {
    assert.deepEqual(
      redirects.map(({ source, destination }) => ({ source, destination })),
      LEGACY_REDIRECTS.map(({ source, destination }) => ({ source, destination })),
    );
    assert.deepEqual(
      beforeFilesRewrites.map(({ source }) => source),
      RETIRED_ROUTES.map(({ source }) => source),
    );
  });

  void test("every redirect is explained by an inventory row", () => {
    const used = new Set(
      ROUTE_INVENTORY.flatMap(({ disposition }) =>
        disposition.class === "redirect" ? [disposition.rule] : [],
      ),
    );
    assert.deepEqual(
      LEGACY_REDIRECTS.filter(({ id }) => !used.has(id)).map(({ id }) => id),
      // Both predate this lane: CourseBuilder's own /live-events alias and the
      // /workshop/:id/thanks half of its original /workshop/:path* rule.
      ["live-events", "workshop-thanks"],
    );
  });

  void test("every retire rule is explained by an inventory row", () => {
    const used = new Set(
      ROUTE_INVENTORY.flatMap(({ disposition }) =>
        disposition.class === "retire" ? [disposition.rule] : [],
      ),
    );
    assert.deepEqual(
      RETIRED_ROUTES.filter(({ id }) => !used.has(id)).map(({ id }) => id),
      [],
    );
  });

  void test("no rule shadows a CourseBuilder route", () => {
    const shadowed = routeTable
      .map(({ route }) => route.replaceAll(/\[\[?\.{0,3}([^\]]+)\]\]?/g, "sample-$1"))
      .filter((sample) => firstMatch(redirects, sample) || firstMatch(beforeFilesRewrites, sample));
    assert.deepEqual(shadowed, []);
  });

  void test("an unknown retire id is a 404, not a 410", async () => {
    const response = await retiredGet(new Request("https://egghead.io/api/retired/nope"), {
      params: Promise.resolve({ rule: "nope" }),
    });
    assert.equal(response.status, 404);
  });
});

void describe("static policy pages", () => {
  void test("FAQ heading anchors keep their legacy fragment ids", () => {
    assert.deepEqual(headingAnchor("Can I pay through invoice? {#pay-invoice}"), {
      text: "Can I pay through invoice?",
      id: "pay-invoice",
    });
    assert.deepEqual(headingAnchor("Plain heading"), { text: "Plain heading", id: undefined });
  });
});
