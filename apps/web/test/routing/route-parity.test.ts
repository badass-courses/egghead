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
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  DELETE as retiredDelete,
  GET as retiredGet,
  OPTIONS as retiredOptions,
  PATCH as retiredPatch,
  POST as retiredPost,
  PUT as retiredPut,
} from "../../src/app/api/retired/[rule]/route";
import { instructorMatchKey } from "../../src/content/encoding";
import { instructorFromSearchParams, searchTermFromRoute } from "../../src/content/search-route";
import {
  escapeLike,
  isLookupableSlug,
  MAX_LEGACY_SLUG_LENGTH,
  uniqueSlug,
} from "../../src/routing/article-alias";
import {
  beforeFilesRewritesForNextConfig,
  CONTENT_REWRITES,
  LEGACY_REDIRECTS,
  legacyRedirectsForNextConfig,
  RETIRED_ROUTE_HANDLER_PREFIX,
  RETIRED_ROUTES,
  retiredRouteDestination,
} from "../../src/routing/legacy-redirects";
import {
  ROUTE_INVENTORY,
  routeInventoryCounts,
  type RouteInventoryRow,
} from "../../src/routing/route-inventory";
import { decodeSlugParam } from "../../src/routing/slug-param";
import { headingAnchor } from "../../src/static-pages/heading-anchor";
import {
  allBeforeFilesRewrites,
  beforeFilesRewrites,
  buildRowSource,
  contentRewrites,
  firstMatch,
  internalRedirects,
  matchesPattern,
  PUBLIC_FILE,
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

  void test("the docs class table matches the inventory", async () => {
    const doc = await readFile(
      new URL("../../../../docs/routing/route-parity.md", import.meta.url),
      "utf8",
    );
    const documented = Object.fromEntries(
      [...doc.matchAll(/^\|\s*(served|redirect|retire|build)\s*\|\s*(\d+)\s*\|/gm)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    assert.deepEqual(documented, routeInventoryCounts().byClass);
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
      assert.equal(response.headers.get("cache-control"), "public, max-age=3600, s-maxage=3600");
      const body = await response.text();
      const reason = RETIRED_ROUTES.find(({ id }) => id === disposition.rule)?.reason ?? "";
      assert.ok(reason && !body.includes(reason), "the internal reason leaks into the body");
      const others = await Promise.all(
        [retiredPost, retiredPut, retiredPatch, retiredDelete, retiredOptions].map((handler) =>
          handler(new Request(`https://egghead.io${row.sample}`), {
            params: Promise.resolve({ rule: disposition.rule }),
          }),
        ),
      );
      assert.deepEqual(
        others.map((other) => other.status),
        [410, 410, 410, 410, 410],
      );
      // OPTIONS is a 410 with no CORS headers; see the handler for why.
      const options = others.at(-1);
      assert.ok(options);
      assert.deepEqual(
        [...options.headers.keys()].filter((key) => key.startsWith("access-control-")),
        [],
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
      redirects.map(({ source, destination, permanent }) => ({ source, destination, permanent })),
      legacyRedirectsForNextConfig(),
    );
    assert.deepEqual(
      allBeforeFilesRewrites.map(({ source, destination }) => ({ source, destination })),
      beforeFilesRewritesForNextConfig(),
    );
    assert.deepEqual(
      beforeFilesRewrites.map(({ source }) => source),
      RETIRED_ROUTES.map(({ source }) => source),
    );
    assert.deepEqual(
      contentRewrites.map(({ source }) => source),
      CONTENT_REWRITES.map(({ source }) => source),
    );
  });

  void test("Next adds no redirect of its own, so trailing slashes take one hop", () => {
    // Fails when next.config.ts loses skipTrailingSlashRedirect: Next then
    // puts its own /:path+/ redirect in front of every legacy rule.
    assert.deepEqual(
      internalRedirects.map(({ source }) => source),
      [],
      "next.config.ts must set skipTrailingSlashRedirect",
    );
  });

  void test("placeholder mappings answer 307, everything else 308", () => {
    const temporary: string[] = LEGACY_REDIRECTS.flatMap((rule) =>
      "temporary" in rule && rule.temporary ? [rule.id] : [],
    );
    assert.deepEqual(temporary.toSorted(), [
      "instructor",
      "instructor-rails-subpage",
      "instructors",
      "learn-topic",
      "learn-topic-page",
      "workshop-fallback",
    ]);
    for (const rule of redirects) {
      const id = redirectIdFor(rule);
      const expected = !(id && temporary.includes(id));
      assert.equal(rule.permanent, expected, `${rule.source} permanent`);
    }
  });

  void test("no redirect or retire rule shadows a content rewrite", () => {
    const shadowed = CONTENT_REWRITES.flatMap(({ source, destination }) => {
      const sample = source.replaceAll(/:(\w+)(\([^)]*\))?[*+?]?/g, "sample-$1");
      const problems = [
        firstMatch(redirects, sample) ? "a redirect" : "",
        firstMatch(redirects, `${sample}/`)?.destination === sample ? "" : "trailing slash",
        firstMatch(beforeFilesRewrites, sample) ? "a retire rule" : "",
        firstMatch(contentRewrites, sample)?.rule.source === source ? "" : "an earlier rewrite",
        resolveAppRoute(sample) ? "" : `no route for ${destination}`,
      ].filter(Boolean);
      return problems.length > 0 ? [`${sample}: ${problems.join(", ")}`] : [];
    });
    assert.deepEqual(shadowed, []);
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

// Paths outside the inventory samples that the review asked about. Each is
// [path, expected outcome]: a redirect destination, "retire:<id>", "free"
// (no rule; the app tree or a build lane owns it).
const EDGE_CASES: readonly (readonly [string, string])[] = [
  // /articles: bare, one segment, and Rails subpages.
  ["/articles", "/blog"],
  ["/articles/some-article", "/blog/some-article"],
  ["/articles/some-article/edit", "/blog/some-article"],
  // Unknown /workshop/* paths go to /workshops; build subpaths stay free.
  ["/workshop/claude-code/old-page", "/workshops/claude-code"],
  ["/workshop/claude-code/a/b", "/workshops/claude-code"],
  ["/workshop/codex/power-user/keyframes/00-00-33-zsh-wrapper.jpg", "free"],
  ["/workshop/invoice", "/workshops/invoice"],
  // egghead-next public/ files.
  ["/tags-sitemap-12.xml", "retire:next-tags-sitemap"],
  ["/bitmovin/receiver.css", "retire:next-bitmovin-assets"],
  ["/.well-known/assetlinks.json", "free"],
  ["/workshop/claude-code/invoice/abc123", "free"],
  ["/workshop/invoice/abc123", "free"],
  ["/workshop/codex/power-user-reference", "free"],
  ["/workshop/codex/power-user-reference/some-topic", "free"],
  // Feed variants stay free of redirects and retire rules; .rss suffixes
  // are content rewrites to the feed routes.
  ["/playlists/some-course/playlist_feed", "free"],
  ["/playlists/some-course/playlist_feed.rss", "free"],
  ["/playlists/some-course/playlist_feed.xml", "free"],
  ["/playlists/some-course/edit", "retire:rails-playlist-subpage"],
  ["/courses/some-course/course_feed", "free"],
  ["/courses/some-course/course_feed.rss", "free"],
  ["/instructors/kent-c-dodds/feed", "free"],
  ["/instructors/kent-c-dodds/feed.rss", "free"],
  ["/instructors/kent-c-dodds/courses", "/q?instructor=kent-c-dodds"],
  // Trailing slashes take one hop to the final destination.
  ["/topics/", "/q"],
  ["/articles/some-article/", "/blog/some-article"],
  ["/instructors/kent-c-dodds/", "/q?instructor=kent-c-dodds"],
  ["/workshop/claude-code/", "/workshops/claude-code"],
  ["/instructors/kent-c-dodds/feed/", "/instructors/kent-c-dodds/feed"],
  ["/courses/some-course/", "/courses/some-course"],
  // An incoming query merges into the destination query; the rule's own
  // param wins on a clash.
  ["/topics?utm_source=x", "/q?utm_source=x"],
  ["/instructors/kent-c-dodds?utm_source=x", "/q?utm_source=x&instructor=kent-c-dodds"],
  ["/instructors/kent-c-dodds?instructor=evil", "/q?instructor=kent-c-dodds"],
];

void describe("edge cases", () => {
  for (const [url, expected] of EDGE_CASES) {
    void test(`${url} -> ${expected}`, () => {
      const redirect = firstMatch(redirects, url);
      if (expected.startsWith("/")) {
        assert.ok(redirect, "no redirect matches");
        assert.equal(redirect.destination, expected);
        assert.equal(firstMatch(redirects, redirect.destination), undefined, "takes two hops");
        return;
      }
      assert.equal(redirect?.destination, undefined, "a redirect captures it");
      const retired = firstMatch(beforeFilesRewrites, url);
      if (expected === "free") {
        assert.equal(retired, undefined, "a retire rule captures it");
      } else {
        assert.equal(
          retired?.destination,
          retiredRouteDestination(expected.slice("retire:".length)),
        );
      }
    });
  }
});

void describe("blog alias helpers", () => {
  void test("escapeLike escapes LIKE wildcards with '!' (no backslashes)", () => {
    assert.equal(escapeLike("plain-slug"), "plain-slug");
    assert.equal(escapeLike("100%_done!"), "100!%!_done!!");
    assert.ok(!escapeLike("a\\b%").includes("\\%"));
  });

  void test("only short, single-segment slugs reach the database", () => {
    assert.equal(isLookupableSlug("manage-reactive-state-with-solid-js-signals"), true);
    assert.equal(isLookupableSlug("a".repeat(MAX_LEGACY_SLUG_LENGTH)), true);
    assert.equal(isLookupableSlug("a".repeat(MAX_LEGACY_SLUG_LENGTH + 1)), false);
    assert.equal(isLookupableSlug(""), false);
    assert.equal(isLookupableSlug("a/b"), false);
  });

  void test("only a single suffixed match resolves; none or two is a 404", () => {
    assert.equal(uniqueSlug([{ slug: "seed~abc12" }]), "seed~abc12");
    assert.equal(uniqueSlug([]), null);
    assert.equal(uniqueSlug([{ slug: "seed~aaaaa" }, { slug: "seed~bbbbb" }]), null);
  });

  void test("malformed percent-encoding decodes to null, not a throw", () => {
    assert.equal(decodeSlugParam("caf%C3%A9"), "café");
    assert.equal(decodeSlugParam("%E0%A4%A"), null);
    assert.equal(decodeSlugParam("%"), null);
  });

  void test("the alias lookup uses the same DB connector as public content", async () => {
    const connectorImport =
      /import \{[^}]*\b(create\w*MysqlConnection)\b[^}]*\} from "\.\.\/db\/local-docker"/;
    const [alias, content] = await Promise.all(
      ["../../src/routing/article-alias.ts", "../../src/content/public-resource.ts"].map((file) =>
        readFile(new URL(file, import.meta.url), "utf8"),
      ),
    );
    const aliasConnector = connectorImport.exec(alias ?? "")?.[1];
    assert.ok(aliasConnector);
    assert.equal(aliasConnector, connectorImport.exec(content ?? "")?.[1]);
  });
});

void describe("egghead-next public files", () => {
  void test("every egghead-next public/ file is served, redirected, retired or owned", async () => {
    const files = (
      await readFile(new URL("./fixtures/egghead-next-public-files.txt", import.meta.url), "utf8")
    )
      .split("\n")
      .filter(Boolean);
    assert.ok(files.length > 0);
    const buildSources = ROUTE_INVENTORY.flatMap((row) =>
      row.disposition.class === "build" ? [buildRowSource(row.legacy)] : [],
    );
    const fixed = new Set(["/robots.txt", "/sitemap.xml", "/favicon.ico", PUBLIC_FILE]);
    const orphans = files.filter((file) => {
      if (firstMatch(redirects, file) || firstMatch(beforeFilesRewrites, file)) return false;
      if (buildSources.some((source) => matchesPattern(source, file))) return false;
      return !fixed.has(resolveAppRoute(file) ?? "");
    });
    assert.deepEqual(orphans, []);
  });
});
