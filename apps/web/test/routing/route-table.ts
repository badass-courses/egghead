// Shared model of how the egghead web app routes a path: the real Next
// config's redirects and beforeFiles rewrites, then the app route tree on
// disk in Next's own priority order. Used by route-parity.test.ts and
// traffic-replay.test.ts.
//
// The matchers come from next/dist internals (path-match, prepare-destination,
// route-regex, sorted-routes) so they behave like the Next server; a Next
// upgrade can move them, and these tests will then fail to import.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { z } from "zod";

import { LEGACY_REDIRECTS } from "../../src/routing/legacy-redirects";

export const webRoot = fileURLToPath(new URL("../..", import.meta.url));
export const appDir = path.join(webRoot, "src", "app");

export type Rule = { source: string; destination: string; permanent?: boolean | undefined };
export type RuleHit = { rule: Rule; destination: string };

// page.{js,jsx,ts,tsx,md,mdx} and route.{js,ts,...} define URLs.
const ROUTE_FILE = /^(page|route)\.(?:jsx?|tsx?|mdx?)$/;
// Root metadata files that Next serves at fixed URLs.
const METADATA_ROUTES: Record<string, string> = {
  "robots.ts": "/robots.txt",
  "sitemap.ts": "/sitemap.xml",
  "manifest.ts": "/manifest.webmanifest",
  "favicon.ico": "/favicon.ico",
  "icon.png": "/icon.png",
  "apple-icon.png": "/apple-icon.png",
};

async function appRoutePaths(dir: string, segments: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        // _private folders are not routes. @slot and (group) folders add no segment.
        if (entry.name.startsWith("_")) return [];
        const addsNoSegment =
          entry.name.startsWith("@") || (entry.name.startsWith("(") && entry.name.endsWith(")"));
        return appRoutePaths(
          path.join(dir, entry.name),
          addsNoSegment ? segments : [...segments, entry.name],
        );
      }
      if (ROUTE_FILE.test(entry.name)) return [`/${segments.join("/")}`];
      const metadataRoute = segments.length === 0 ? METADATA_ROUTES[entry.name] : undefined;
      return metadataRoute ? [metadataRoute] : [];
    }),
  );
  return [...new Set(nested.flat())];
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
    z.object({
      source: z.string(),
      destination: z.string(),
      permanent: z.boolean().optional(),
      internal: z.boolean().optional(),
    }),
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
export const redirects: Rule[] = customRoutes.redirects.filter((route) => route.internal !== true);
// Redirects Next adds itself, such as its trailing-slash rule. Empty while
// next.config.ts sets skipTrailingSlashRedirect.
export const internalRedirects: Rule[] = customRoutes.redirects.filter(
  (route) => route.internal === true,
);
export const beforeFilesRewrites: Rule[] = customRoutes.rewrites.beforeFiles;
export const routeTable = getSortedRoutes(await appRoutePaths(appDir)).map((route) => ({
  route,
  re: getRouteRegex(route).re,
}));

export function pathnameOf(url: string) {
  return new URL(url, "https://egghead.io").pathname;
}

// Files in apps/web/public, served at their path before any dynamic route.
async function publicFilePaths(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? publicFilePaths(path.join(dir, entry.name), `${prefix}/${entry.name}`)
        : Promise.resolve([`${prefix}/${entry.name}`]),
    ),
  );
  return nested.flat();
}

export const PUBLIC_FILE = "public";
export const publicFiles: ReadonlySet<string> = new Set(
  await publicFilePaths(path.join(webRoot, "public")),
);

// The app route that answers a path, or PUBLIC_FILE for a file in public/.
export function resolveAppRoute(url: string) {
  const pathname = pathnameOf(url);
  if (publicFiles.has(decodeURI(pathname))) return PUBLIC_FILE;
  return routeTable.find(({ re }) => re.test(pathname))?.route;
}

// A path that names a file (an extension on its last segment) or a dot
// directory such as /.well-known. A dynamic page such as /[slug]/[entry]
// matches these paths but never answers them with the file.
export function isFileLikePath(url: string) {
  const pathname = pathnameOf(url);
  return /\/\./.test(pathname) || /\.[A-Za-z0-9]+$/.test(pathname);
}

export function matchesPattern(source: string, url: string) {
  return (
    getPathMatch(source, { removeUnnamedParams: true, strict: true })(pathnameOf(url)) !== false
  );
}

// The incoming query merges into the destination query the way the Next
// server does it; a destination param wins over an incoming one.
export function firstMatch(rules: readonly Rule[], url: string): RuleHit | undefined {
  const incoming = new URL(url, "https://egghead.io");
  const pathname = incoming.pathname;
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(incoming.searchParams.keys())) {
    const values = incoming.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (params === false) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    });
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parsedDestination.query)) {
      for (const item of [value ?? []].flat()) search.append(key, item);
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    return { rule, destination: `${parsedDestination.pathname}${suffix}` };
  }
  return undefined;
}

// A trailing-slash twin reports the id of the rule it mirrors.
export function redirectIdFor(rule: Rule) {
  return LEGACY_REDIRECTS.find(
    (candidate) => candidate.source === rule.source || `${candidate.source}/` === rule.source,
  )?.id;
}

// Build rows carry an egghead-next pattern such as /i/[slug]/rss.xml or
// /courses/:id/course_feed; normalize to a path-to-regexp source.
export function buildRowSource(legacy: string) {
  return legacy
    .replaceAll(/\[\[\.\.\.([^\]]+)\]\]/g, ":$1*")
    .replaceAll(/\[\.\.\.([^\]]+)\]/g, ":$1+")
    .replaceAll(/\[([^\]]+)\]/g, ":$1");
}
