import {
  EGGHEAD_SITE_URL,
  SITEMAP_EXCLUDED_LEGACY_PREFIXES,
  SITEMAP_STATIC_PATHS,
  absoluteSitemapUrl,
  robotsPolicy,
} from "../apps/web/src/content/sitemap";

function assertEqual(
  name: string,
  actual: string | number | boolean,
  expected: string | number | boolean,
) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return { name, pass: true as const };
}

function assertIncludes<T>(name: string, values: readonly T[], expected: T) {
  if (!values.includes(expected)) {
    throw new Error(`${name}: expected ${String(expected)} in ${JSON.stringify(values)}`);
  }

  return { name, pass: true as const };
}

function assertNotIncludes<T>(name: string, values: readonly T[], blocked: T) {
  if (values.includes(blocked)) {
    throw new Error(`${name}: did not expect ${String(blocked)} in ${JSON.stringify(values)}`);
  }

  return { name, pass: true as const };
}

const robots = robotsPolicy();
const staticPaths = SITEMAP_STATIC_PATHS.map(String);
const checks = [
  assertEqual(
    "canonical sitemap host matches page metadata host",
    EGGHEAD_SITE_URL,
    "https://egghead.io",
  ),
  assertEqual(
    "absolute sitemap URL normalizes leading slash",
    absoluteSitemapUrl("modern-three-js"),
    "https://egghead.io/modern-three-js",
  ),
  assertIncludes("sitemap includes root", SITEMAP_STATIC_PATHS, "/"),
  assertIncludes("sitemap includes courses index", SITEMAP_STATIC_PATHS, "/courses"),
  assertIncludes("sitemap includes lessons index", SITEMAP_STATIC_PATHS, "/lessons"),
  assertIncludes("sitemap includes blog index", SITEMAP_STATIC_PATHS, "/blog"),
  assertIncludes("sitemap includes podcasts index", SITEMAP_STATIC_PATHS, "/podcasts"),
  assertIncludes("sitemap includes talks index", SITEMAP_STATIC_PATHS, "/talks"),
  assertNotIncludes("sitemap excludes retired guides index", staticPaths, "/guides"),
  assertNotIncludes("sitemap excludes retired projects index", staticPaths, "/projects"),
  assertNotIncludes("sitemap excludes migrated tips index", staticPaths, "/tips"),
  assertNotIncludes(
    "sitemap excludes retired guide detail prefix",
    SITEMAP_EXCLUDED_LEGACY_PREFIXES,
    "/guides/",
  ),
  assertNotIncludes(
    "sitemap excludes retired project detail prefix",
    SITEMAP_EXCLUDED_LEGACY_PREFIXES,
    "/projects/",
  ),
  assertNotIncludes(
    "sitemap excludes migrated tip detail prefix",
    SITEMAP_EXCLUDED_LEGACY_PREFIXES,
    "/tips/",
  ),
  assertIncludes(
    "sitemap records legacy course prefix as excluded",
    SITEMAP_EXCLUDED_LEGACY_PREFIXES,
    "/courses/",
  ),
  assertIncludes(
    "sitemap records legacy lesson prefix as excluded",
    SITEMAP_EXCLUDED_LEGACY_PREFIXES,
    "/lessons/",
  ),
  assertNotIncludes(
    "static sitemap paths do not include legacy lesson detail paths",
    staticPaths,
    "/lessons/example",
  ),
  assertEqual(
    "robots advertises sitemap.xml",
    String(robots.sitemap),
    "https://egghead.io/sitemap.xml",
  ),
];

console.log(
  JSON.stringify({
    ok: true,
    checks,
    invariant: {
      canonicalHost: EGGHEAD_SITE_URL,
      sitemapSurface: "/sitemap.xml",
      robotsSurface: "/robots.txt",
      canonicalOnlyDetails: true,
      legacyDetailPathsExcludedFromSitemap: [...SITEMAP_EXCLUDED_LEGACY_PREFIXES],
    },
  }),
);
