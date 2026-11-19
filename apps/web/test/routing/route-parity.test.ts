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
import { describe, test } from "node:test";

import {
  DELETE as retiredDelete,
  GET as retiredGet,
  PATCH as retiredPatch,
  PUT as retiredPut,
} from "../../src/app/api/retired/[rule]/route";
import { instructorMatchKey } from "../../src/content/encoding";
import { instructorFromSearchParams, searchTermFromRoute } from "../../src/content/search-route";
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
import {
  beforeFilesRewrites,
  firstMatch,
  redirectIdFor,
  redirects,
  resolveAppRoute,
  routeTable,
} from "./route-table";

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

void describe("search redirects carry params CourseBuilder search reads", () => {
  for (const row of ROUTE_INVENTORY) {
    const { disposition } = row;
    if (disposition.class !== "redirect" || !disposition.destination.startsWith("/q")) continue;
    void test(`${label(row)} -> ${disposition.destination}`, () => {
      const url = new URL(disposition.destination, "https://egghead.io");
      const all = url.pathname.split("/").slice(2).filter(Boolean);
      // Shaped like Next's searchParams prop: only keys present in the URL.
      const searchParams = Object.fromEntries(
        ["q", "instructor"].flatMap((key) => {
          const value = url.searchParams.get(key);
          return value === null ? [] : [[key, value]];
        }),
      );
      const term = searchTermFromRoute({ params: { all }, searchParams });
      const instructor = instructorFromSearchParams(searchParams);
      // Every search redirect must reach the search page with a term, an
      // instructor filter, or neither on purpose (the bare /q index).
      if (url.searchParams.has("q") || all.length > 0) assert.ok(term, "search term is dropped");
      if (url.searchParams.has("instructor")) assert.ok(instructor, "instructor filter is dropped");
    });
  }

  // Search matches instructors by instructorMatchKey, so the slug from a
  // legacy URL finds the display name.
  void test("an instructor slug matches the display name key", () => {
    assert.equal(instructorMatchKey("kent-c-dodds"), instructorMatchKey("Kent C. Dodds"));
  });
});

void describe("retire rows answer 410 for every method, without the reason", () => {
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
      const body = await response.text();
      const reason = RETIRED_ROUTES.find(({ id }) => id === disposition.rule)?.reason ?? "";
      assert.ok(reason && !body.includes(reason), "the internal reason leaks into the body");
      const others = await Promise.all(
        [retiredPut, retiredPatch, retiredDelete].map((handler) =>
          handler(new Request(`https://egghead.io${row.sample}`), {
            params: Promise.resolve({ rule: disposition.rule }),
          }),
        ),
      );
      assert.deepEqual(
        others.map((other) => other.status),
        [410, 410, 410],
      );
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
      [],
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
