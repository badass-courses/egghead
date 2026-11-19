// HTTP smoke for legacy-route behavior against a running egghead web server.
//
//   pnpm routing:not-found:smoke --base http://127.0.0.1:3019 \
//     --known /some-course --known /some-course/some-lesson \
//     --unknown /some-course/missing-lesson \
//     --redirect /blog/some-article=/some-article~abc12 \
//     --session-cookie 'authjs.session-token=...'
//
// Checks, over real HTTP:
// - unknown content URLs answer a real 404 (not 500, not a soft 200),
//   including encoded and malformed slugs, and reports their Cache-Control;
// - known URLs (--known) answer 200, and --redirect from=to pairs answer 308;
// - every redirect row in the route inventory answers 308 with the expected
//   Location; trailing slashes take one hop; an incoming query merges into
//   the destination query;
// - every retire row answers 410 (HTML for pages, JSON with the rule id for
//   APIs), and retired APIs also answer 410 to POST, HEAD and OPTIONS;
// - /api/nav-account answers the anonymous shape signed out and, with
//   --session-cookie, a display name signed in, both private and no-store.
// It also reports, without failing, what every build row answers today, so
// the flip checklist shows which build paths 404.
// Exits non-zero on any mismatch and prints a JSON summary.

import { parseArgs } from "node:util";

import {
  LEGACY_REDIRECTS,
  type LegacyRedirect,
  RETIRED_ROUTES,
} from "../apps/web/src/routing/legacy-redirects";
import { ROUTE_INVENTORY } from "../apps/web/src/routing/route-inventory";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3008" },
    known: { type: "string", multiple: true, default: [] },
    unknown: { type: "string", multiple: true, default: [] },
    redirect: { type: "string", multiple: true, default: [] },
    "session-cookie": { type: "string" },
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
  // egghead.io 404s this today too; egghead has no Android app links file.
  "/.well-known/assetlinks.json",
  // Percent-encoded slugs are ordinary 404s.
  "/blog/caf%C3%A9-zz",
  "/zz%20missing",
  "/zz-missing/caf%C3%A9",
];
// Malformed percent-encoding. Next 16.2.5 fails to decode these in its router
// before any app code runs: it means to answer 400, fails to render /400 in
// an app-router-only build, and answers a plain 500. Reported, not failed,
// because no app code can change it; the app's own decode
// (src/routing/slug-param.ts) is a 404 for anything that reaches it.
const MALFORMED_PATHS = [
  "/%E0%A4%A",
  "/blog/%E0%A4%A",
  "/zz-missing/%E0%A4%A",
  "/courses/%E0%A4%A",
];
// Pages that call notFound() inside their own <Suspense> answer a soft 200.
// Same list as KNOWN_SOFT_404_PAGES in apps/web/test/routing/not-found-guards.test.ts;
// move a path to UNKNOWN_PATHS when its page is fixed.
const KNOWN_SOFT_404_PATHS = [`/workshops/${MISSING}`];
// Search for an unknown term is a working page with no results, not a 404.
const SEARCH_PATHS = [`/q/${MISSING}`, `/q?q=${MISSING}`, "/q?post=podcasts&type=podcast"];

type Method = "GET" | "POST" | "HEAD" | "OPTIONS";

type Check = {
  name: string;
  path: string;
  method?: Method;
  cookie?: string;
  expectStatus: number;
  expectLocation?: string;
  expectContentType?: string;
  expectBodyIncludes?: string;
  expectCacheControl?: string;
};

type Result = Check & {
  status: number;
  location: string | null;
  duplicateLocation: boolean;
  contentType: string | null;
  cacheControl: string | null;
  ok: boolean;
};

// egghead-next public/ files copied into apps/web/public.
const PUBLIC_FILES = [
  "/site.webmanifest",
  "/opensearch.xml",
  "/apple-touch-icon.png",
  "/android-chrome-512x512.png",
  "/images/eggo.svg",
  "/emojis/nerd@2x.png",
];

// Placeholder mappings answer 307; every other legacy redirect answers 308.
const legacyRules: readonly LegacyRedirect[] = LEGACY_REDIRECTS;
const temporaryRules: ReadonlySet<string> = new Set(
  legacyRules.flatMap((rule) => (rule.temporary ? [rule.id] : [])),
);
const redirectStatus = (rule: string) => (temporaryRules.has(rule) ? 307 : 308);

const retiredKinds: ReadonlyMap<string, string> = new Map(
  RETIRED_ROUTES.map((route) => [route.id, route.kind]),
);

const redirectPairs = values.redirect.map((pair) => {
  const [from, to] = pair.split("=");
  if (!from || !to) throw new Error(`--redirect expects from=to, got ${pair}`);
  return { from, to };
});

const checks: Check[] = [
  ...[...UNKNOWN_PATHS, ...values.unknown].map((path) => ({
    name: "unknown content 404",
    path,
    expectStatus: 404,
  })),
  ...values.known.map((path) => ({ name: "known content 200", path, expectStatus: 200 })),
  ...redirectPairs.map(({ from, to }) => ({
    name: "content alias 308",
    path: from,
    expectStatus: 308,
    expectLocation: to,
  })),
  ...SEARCH_PATHS.map((path) => ({ name: "search page 200", path, expectStatus: 200 })),
  ...PUBLIC_FILES.map((path) => ({ name: "public file 200", path, expectStatus: 200 })),
  ...KNOWN_SOFT_404_PATHS.map((path) => ({
    name: "known soft 404 (follow-up)",
    path,
    expectStatus: 200,
  })),
  // Edges: trailing slash in one hop, query merging.
  ...(
    [
      ["/topics?utm_source=route-parity", "/q?utm_source=route-parity"],
      ["/topics/", "/q"],
      ["/articles/some-article/", "/blog/some-article"],
      ["/courses/some-course/", "/courses/some-course"],
      ["/workshop/claude-code/old-page", "/workshops/claude-code"],
    ] as const
  ).map(([path, expectLocation]) => ({
    name: "redirect edge",
    path,
    expectStatus: path.startsWith("/workshop/") ? 307 : 308,
    expectLocation,
  })),
  ...(
    [
      [
        "/instructors/kent-c-dodds?utm_source=route-parity",
        "/q?instructor=kent-c-dodds&utm_source=route-parity",
      ],
      ["/instructors/kent-c-dodds?instructor=evil", "/q?instructor=kent-c-dodds"],
      ["/instructors/kent-c-dodds/", "/q?instructor=kent-c-dodds"],
    ] as const
  ).map(([path, expectLocation]) => ({
    name: "redirect edge (placeholder)",
    path,
    expectStatus: 307,
    expectLocation,
  })),
  {
    name: "nav account signed out",
    path: "/api/nav-account",
    expectStatus: 200,
    expectBodyIncludes: '"displayName":null',
    expectCacheControl: "private, no-store",
  },
];

const sessionCookie = values["session-cookie"];
if (sessionCookie) {
  checks.push({
    name: "nav account signed in",
    path: "/api/nav-account",
    cookie: sessionCookie,
    expectStatus: 200,
    expectBodyIncludes: '"displayName":"',
    expectCacheControl: "private, no-store",
  });
}

for (const row of ROUTE_INVENTORY) {
  const { disposition } = row;
  if (disposition.class === "redirect") {
    checks.push({
      name: `redirect ${disposition.rule}`,
      path: row.sample,
      expectStatus: redirectStatus(disposition.rule),
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
        ...(["POST", "HEAD", "OPTIONS"] as const).map((method) => ({
          name: `retire ${disposition.rule} ${method}`,
          path: row.sample,
          method,
          expectStatus: 410,
        })),
      );
    }
  }
}

// Same path and query, with query keys in a stable order. Next 16.2.5 sends
// the Location header twice (same value) on the first, uncached render of a
// page-level permanentRedirect(); fetch joins them with ", ". Identical
// duplicates collapse to one value and are reported as duplicateLocation.
function locationValues(header: string | null) {
  return header ? [...new Set(header.split(", "))] : [];
}

function normalizedPath(location: string | null) {
  const [first, ...rest] = locationValues(location);
  if (!first || rest.length > 0) return location;
  const url = new URL(first, values.base);
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

async function request(path: string, method: Method = "GET", cookie?: string) {
  return fetch(new URL(path, values.base), {
    method,
    redirect: "manual",
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

async function run(check: Check): Promise<Result> {
  const response = await request(check.path, check.method, check.cookie);
  const body = check.method === "HEAD" ? "" : await response.text();
  const location = normalizedPath(response.headers.get("location"));
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  const ok =
    response.status === check.expectStatus &&
    (check.expectLocation === undefined || location === normalizedPath(check.expectLocation)) &&
    (check.expectContentType === undefined ||
      Boolean(contentType?.startsWith(check.expectContentType))) &&
    (check.expectBodyIncludes === undefined || body.includes(check.expectBodyIncludes)) &&
    (check.expectCacheControl === undefined || cacheControl === check.expectCacheControl);
  const rawLocation = response.headers.get("location");
  return {
    ...check,
    status: response.status,
    location,
    duplicateLocation: Boolean(rawLocation?.includes(", ")),
    contentType,
    cacheControl,
    ok,
  };
}

// Report only: what each build row answers before its lane lands.
async function buildRowStatus() {
  const rows = ROUTE_INVENTORY.flatMap((row) =>
    row.disposition.class === "build" ? [{ row, lane: row.disposition.lane }] : [],
  );
  return Promise.all(
    rows.map(async ({ row, lane }) => {
      const response = await request(row.sample);
      await response.arrayBuffer();
      return {
        lane,
        legacy: row.legacy,
        sample: row.sample,
        status: response.status,
        location: normalizedPath(response.headers.get("location")),
      };
    }),
  );
}

async function malformedStatus() {
  return Promise.all(
    MALFORMED_PATHS.map(async (path) => {
      const response = await request(path);
      await response.arrayBuffer();
      return { path, status: response.status };
    }),
  );
}

const [results, buildRows, malformed] = await Promise.all([
  Promise.all(checks.map(run)),
  buildRowStatus(),
  malformedStatus(),
]);
const failures = results.filter((result) => !result.ok);
const notFoundCacheControl = Object.fromEntries(
  results
    .filter((result) => result.expectStatus === 404)
    .map((result) => [result.path, result.cacheControl]),
);
const names = [...new Set(results.map((result) => result.name.split(" ")[0] ?? ""))];
const counts = Object.fromEntries(
  names.map((prefix) => [
    prefix,
    results.filter((result) => result.name.split(" ")[0] === prefix).length,
  ]),
);
const buildByStatus = Object.fromEntries(
  [...new Set(buildRows.map((row) => row.status))]
    .toSorted((a, b) => a - b)
    .map((status) => [status, buildRows.filter((row) => row.status === status).length]),
);

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      base: values.base,
      checked: results.length,
      signedInChecked: Boolean(sessionCookie),
      counts,
      notFoundCacheControl,
      duplicateLocation: results
        .filter((result) => result.duplicateLocation)
        .map((result) => result.path),
      malformedUrls: malformed,
      buildRows: { byStatus: buildByStatus, rows: buildRows },
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
