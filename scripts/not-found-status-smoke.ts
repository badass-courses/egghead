// HTTP smoke for legacy-route behavior against a running egghead web server.
//
//   pnpm routing:not-found:smoke --base http://127.0.0.1:3019 \
//     --known /some-course --known /some-course/some-lesson \
//     --unknown /some-course/missing-lesson
//
// Checks, over real HTTP:
// - unknown content URLs answer a real 404 (not 500, not a soft 200), and
//   reports their Cache-Control;
// - known URLs (--known) answer 200;
// - every redirect row in the route inventory answers 308 with the expected
//   Location, and a source query string passes through;
// - every retire row answers 410 (HTML for pages, JSON with the rule id for
//   APIs), and retired APIs also answer 410 to POST and HEAD.
// Exits non-zero on any mismatch and prints a JSON summary.

import { parseArgs } from "node:util";

import { RETIRED_ROUTES } from "../apps/web/src/routing/legacy-redirects";
import { ROUTE_INVENTORY } from "../apps/web/src/routing/route-inventory";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3008" },
    known: { type: "string", multiple: true, default: [] },
    unknown: { type: "string", multiple: true, default: [] },
  },
});

const MISSING = "zz-route-parity-missing";
const UNKNOWN_PATHS = [
  `/${MISSING}`,
  `/${MISSING}/zz-entry`,
  `/courses/${MISSING}`,
  `/lessons/${MISSING}`,
  `/lessons/${MISSING}/embed`,
  `/talks/${MISSING}`,
  `/podcasts/${MISSING}`,
  `/blog/${MISSING}`,
  `/case-studies/${MISSING}`,
  `/success-stories/${MISSING}`,
  `/campaigns/${MISSING}`,
];
// Pages that call notFound() inside their own <Suspense> answer a soft 200.
// Same list as KNOWN_SOFT_404_PAGES in apps/web/test/routing/not-found-guards.test.ts;
// move a path to UNKNOWN_PATHS when its page is fixed.
const KNOWN_SOFT_404_PATHS = [`/workshops/${MISSING}`];
// Search for an unknown term is a working page with no results, not a 404.
const SEARCH_PATHS = [`/q/${MISSING}`, `/q?q=${MISSING}`, "/q?post=podcasts&type=podcast"];

type Check = {
  name: string;
  path: string;
  method?: "GET" | "POST" | "HEAD";
  expectStatus: number;
  expectLocation?: string;
  expectContentType?: string;
  expectBodyIncludes?: string;
};

type Result = Check & {
  status: number;
  location: string | null;
  contentType: string | null;
  cacheControl: string | null;
  ok: boolean;
};

const retiredKinds: ReadonlyMap<string, string> = new Map(
  RETIRED_ROUTES.map((route) => [route.id, route.kind]),
);

const checks: Check[] = [
  ...[...UNKNOWN_PATHS, ...values.unknown].map((path) => ({
    name: "unknown content 404",
    path,
    expectStatus: 404,
  })),
  ...values.known.map((path) => ({ name: "known content 200", path, expectStatus: 200 })),
  ...SEARCH_PATHS.map((path) => ({ name: "search page 200", path, expectStatus: 200 })),
  ...KNOWN_SOFT_404_PATHS.map((path) => ({
    name: "known soft 404 (follow-up)",
    path,
    expectStatus: 200,
  })),
  {
    name: "redirect keeps the source query",
    path: "/topics?utm_source=route-parity",
    expectStatus: 308,
    expectLocation: "/q?utm_source=route-parity",
  },
];

for (const row of ROUTE_INVENTORY) {
  const { disposition } = row;
  if (disposition.class === "redirect") {
    checks.push({
      name: `redirect ${disposition.rule}`,
      path: row.sample,
      expectStatus: 308,
      expectLocation: disposition.destination,
    });
  }
  if (disposition.class === "retire") {
    const api = retiredKinds.get(disposition.rule) === "api";
    checks.push({
      name: `retire ${disposition.rule}`,
      path: row.sample,
      expectStatus: 410,
      expectContentType: api ? "application/json" : "text/html",
      ...(api ? { expectBodyIncludes: `"rule":"${disposition.rule}"` } : {}),
    });
    if (api) {
      checks.push(
        {
          name: `retire ${disposition.rule} POST`,
          path: row.sample,
          method: "POST",
          expectStatus: 410,
        },
        {
          name: `retire ${disposition.rule} HEAD`,
          path: row.sample,
          method: "HEAD",
          expectStatus: 410,
        },
      );
    }
  }
}

function locationPath(location: string | null) {
  if (!location) return null;
  const url = new URL(location, values.base);
  return `${url.pathname}${url.search}`;
}

async function run(check: Check): Promise<Result> {
  const response = await fetch(new URL(check.path, values.base), {
    method: check.method ?? "GET",
    redirect: "manual",
  });
  const body = check.method === "HEAD" ? "" : await response.text();
  const location = locationPath(response.headers.get("location"));
  const contentType = response.headers.get("content-type");
  const ok =
    response.status === check.expectStatus &&
    (check.expectLocation === undefined || location === check.expectLocation) &&
    (check.expectContentType === undefined ||
      Boolean(contentType?.startsWith(check.expectContentType))) &&
    (check.expectBodyIncludes === undefined || body.includes(check.expectBodyIncludes));
  return {
    ...check,
    status: response.status,
    location,
    contentType,
    cacheControl: response.headers.get("cache-control"),
    ok,
  };
}

const results = await Promise.all(checks.map(run));
const failures = results.filter((result) => !result.ok);
const notFoundCacheControl = Object.fromEntries(
  results
    .filter((result) => result.expectStatus === 404)
    .map((result) => [result.path, result.cacheControl]),
);
const counts = Object.fromEntries(
  ["unknown content 404", "known content 200", "search page 200", "known soft 404 (follow-up)"].map(
    (name) => [name, results.filter((result) => result.name === name).length],
  ),
);

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      base: values.base,
      checked: results.length,
      counts: {
        ...counts,
        redirects: results.filter((result) => result.expectStatus === 308).length,
        retires: results.filter((result) => result.expectStatus === 410).length,
      },
      notFoundCacheControl,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
