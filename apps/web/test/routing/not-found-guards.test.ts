// Guards for real 404s on content routes.
//
// Root cause (2026-11-19): under cacheComponents, notFound() on a
// generateStaticParams route renders in Next's legacy prerender store. A
// session read anywhere in a layout's module tree sets revalidate to 0 there,
// and Next 16.2 answers 500. A loading.tsx or Suspense boundary above the
// notFound() lets the 200 shell stream first, so the 404 becomes a soft 200.
// HTTP status proof against a running server is
// scripts/not-found-status-smoke.ts.

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANONYMOUS_NAV_ACCOUNT,
  navAccountResponse,
  NAV_ACCOUNT_REFRESH_MS,
  navAccountState,
  parseNavAccountState,
  shouldRefreshNavAccount,
} from "../../src/coursebuilder/nav-account";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = path.join(webRoot, "src");
const appDir = path.join(srcDir, "app");
const repoRoot = path.resolve(webRoot, "..", "..");

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : Promise.resolve([path.join(dir, entry.name)]),
    ),
  );
  return nested.flat();
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

async function resolveFile(base: string): Promise<string | undefined> {
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  const found = await Promise.all(
    candidates.map(async (candidate) =>
      SOURCE_EXTENSIONS.some((ext) => candidate.endsWith(ext)) && (await exists(candidate))
        ? candidate
        : undefined,
    ),
  );
  return found.find(Boolean);
}

// Workspace packages are resolved through their package.json exports map.
async function resolveWorkspaceImport(specifier: string): Promise<string | undefined> {
  const match = /^@egghead\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return undefined;
  const [, name, subpath = ""] = match;
  const packageDir = path.join(repoRoot, "packages", name ?? "");
  const manifestFile = path.join(packageDir, "package.json");
  if (!(await exists(manifestFile))) return undefined;
  const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("exports" in manifest))
    return undefined;
  const { exports } = manifest;
  if (typeof exports !== "object" || exports === null) return undefined;
  const target: unknown = Object.entries(exports).find(([key]) => key === `.${subpath}`)?.[1];
  return typeof target === "string" ? resolveFile(path.join(packageDir, target)) : undefined;
}

// `import x from "m"`, `export … from "m"`, `import("m")` and side-effect `import "m"`.
const IMPORT_SPECIFIER =
  /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

async function resolveImport(fromFile: string, specifier: string) {
  if (specifier.startsWith("."))
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  if (specifier.startsWith("@/")) return resolveFile(path.join(srcDir, specifier.slice(2)));
  return resolveWorkspaceImport(specifier);
}

// Every module reachable from `entry` through relative, @/ and @egghead/*
// imports, plus the bare specifiers they use.
async function moduleTree(entry: string) {
  const files = new Set<string>();
  const bareImports = new Map<string, string>();

  async function visit(file: string): Promise<void> {
    if (files.has(file)) return;
    files.add(file);
    const source = await readFile(file, "utf8");
    const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].flatMap((m) =>
      [m[1], m[2], m[3]].filter((value): value is string => Boolean(value)),
    );
    await Promise.all(
      specifiers.map(async (specifier) => {
        const resolved = await resolveImport(file, specifier);
        if (resolved) return visit(resolved);
        bareImports.set(specifier, file);
        return undefined;
      }),
    );
  }

  await visit(entry);
  return { files, bareImports };
}

const SESSION_MODULES = new Set([
  path.join(srcDir, "server", "auth.ts"),
  path.join(srcDir, "coursebuilder", "current-user.ts"),
]);
const SESSION_PACKAGES = new Set(["next/headers", "next-auth", "next-auth/react"]);

// Every file that renders around a notFound(): layouts, templates, and the
// not-found and error boundaries themselves.
const SHELL_FILES = new Set([
  "layout.tsx",
  "template.tsx",
  "not-found.tsx",
  "error.tsx",
  "global-error.tsx",
]);

void describe("shell module trees stay free of server session reads", () => {
  void test("no layout, template, not-found or error file reaches a session read", async () => {
    const layouts = (await walk(appDir)).filter((file) => SHELL_FILES.has(path.basename(file)));
    assert.ok(layouts.some((file) => path.basename(file) === "layout.tsx"));
    assert.ok(layouts.some((file) => path.basename(file) === "not-found.tsx"));
    const offenders = (
      await Promise.all(
        layouts.map(async (layout) => {
          const { files, bareImports } = await moduleTree(layout);
          const name = path.relative(webRoot, layout);
          const moduleHits = [...files]
            .filter((file) => SESSION_MODULES.has(file))
            .map((file) => `${name} -> ${path.relative(webRoot, file)}`);
          return moduleHits.concat(
            [...bareImports]
              .filter(([specifier]) => SESSION_PACKAGES.has(specifier))
              .map(
                ([specifier, from]) =>
                  `${name} -> ${path.relative(webRoot, from)} imports ${specifier}`,
              ),
          );
        }),
      )
    ).flat();
    assert.deepEqual(offenders, []);
  });

  void test("the walk follows aliases and workspace packages", async () => {
    const { files } = await moduleTree(path.join(appDir, "layout.tsx"));
    const relative = [...files].map((file) => path.relative(repoRoot, file));
    assert.ok(relative.includes("apps/web/src/app/site-nav-with-account.tsx"));
    assert.ok(relative.includes("apps/web/src/coursebuilder/nav-account.ts"));
    assert.ok(relative.some((file) => file.startsWith("packages/ui/src/")));
  });

  void test("the account nav is a client component", async () => {
    const nav = await readFile(path.join(appDir, "site-nav-with-account.tsx"), "utf8");
    assert.ok(
      nav.startsWith('"use client";'),
      "site-nav-with-account.tsx must stay a client component",
    );
  });
});

// Pages that call notFound() inside their own <Suspense>. They answer a soft
// 200 for unknown ids. Outside this lane's write scope; reported as follow-up.
// Fixing one means removing it here.
const KNOWN_SOFT_404_PAGES = [
  "local/workshops/[id]/page.tsx",
  "local/workshops/page.tsx",
  "profile/[publicId]/page.tsx",
  "profile/page.tsx",
  "team/invite/[token]/page.tsx",
  "workshops/[id]/page.tsx",
  "workshops/[id]/thanks/page.tsx",
];

const ancestors = (root: string, page: string) => {
  const dirs: string[] = [];
  for (let dir = path.dirname(page); dir.startsWith(root); dir = path.dirname(dir)) {
    dirs.push(dir);
  }
  return dirs;
};

// A page "calls notFound()" when its own source does, or when a module it
// imports directly (relative, @/ or @egghead/*) does. One level deep: helpers
// such as slugParamOrNotFound count; deeper chains are not followed.
async function callsNotFound(page: string, source: string) {
  if (source.includes("notFound(")) return true;
  const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].flatMap((m) =>
    [m[1], m[2], m[3]].filter((value): value is string => Boolean(value)),
  );
  const helpers = await Promise.all(
    specifiers.map(async (specifier) => {
      const resolved = await resolveImport(page, specifier);
      return resolved ? (await readFile(resolved, "utf8")).includes("notFound(") : false;
    }),
  );
  return helpers.some(Boolean);
}

// Streaming boundaries that would let a 200 shell go out before a notFound().
async function softNotFoundFindings(root: string) {
  const files = await walk(root);
  const pages = files.filter((file) => file.endsWith("/page.tsx"));
  const layouts = files.filter((file) => path.basename(file) === "layout.tsx");
  const pageFindings = await Promise.all(
    pages.map(async (page) => {
      const source = await readFile(page, "utf8");
      if (!(await callsNotFound(page, source))) return [];
      const relative = path.relative(root, page);
      const loadingDirs = (
        await Promise.all(
          ancestors(root, page).map(async (dir) =>
            (await exists(path.join(dir, "loading.tsx"))) ? [dir] : [],
          ),
        )
      ).flat();
      return loadingDirs
        .map((dir) => `${relative}: loading.tsx in ${path.relative(root, dir) || "app"}`)
        .concat(source.includes("<Suspense") ? [`${relative}: <Suspense> in page`] : []);
    }),
  );
  // A layout that wraps {children} in <Suspense> streams before any page.
  const layoutFindings = await Promise.all(
    layouts.map(async (layout) => {
      const source = await readFile(layout, "utf8");
      const suspended = [...source.matchAll(/<Suspense[\s\S]*?<\/Suspense>/g)].some((block) =>
        block[0].includes("{children}"),
      );
      return suspended ? [`${path.relative(root, layout)}: {children} inside <Suspense>`] : [];
    }),
  );
  return [...pageFindings, ...layoutFindings].flat().toSorted();
}

void describe("no streaming boundary sits above a notFound()", () => {
  void test("every notFound() page answers a real status", async () => {
    assert.deepEqual(
      await softNotFoundFindings(appDir),
      KNOWN_SOFT_404_PAGES.map((page) => `${page}: <Suspense> in page`).toSorted(),
    );
  });

  void test("a notFound() inside an imported helper still counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "not-found-guard-"));
    await mkdir(path.join(root, "things", "[id]"), { recursive: true });
    await writeFile(
      path.join(root, "lookup.ts"),
      'import { notFound } from "next/navigation";\nexport function find() { notFound(); }\n',
    );
    await writeFile(
      path.join(root, "things", "[id]", "page.tsx"),
      'import { find } from "../../lookup";\nexport default function Page() { find(); return null; }\n',
    );
    await writeFile(
      path.join(root, "things", "loading.tsx"),
      "export default function L() { return null; }\n",
    );
    assert.deepEqual(await softNotFoundFindings(root), [
      "things/[id]/page.tsx: loading.tsx in things",
    ]);
  });

  void test("no middleware or proxy sits outside the route model", async () => {
    // The parity and replay tests model redirects, rewrites and the file tree.
    // A middleware or proxy would run before rewrites and is not modelled.
    const present = await Promise.all(
      ["middleware.ts", "proxy.ts", "middleware.js", "proxy.js"].map((file) =>
        exists(path.join(srcDir, file)),
      ),
    );
    assert.deepEqual(present, [false, false, false, false]);
  });
});

void describe("nav account state", () => {
  void test("signed out is a 200 with the anonymous shape and no-store", async () => {
    const response = navAccountResponse(navAccountState(null));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { displayName: null, hasProSubscription: false });
  });

  void test("signed in returns only displayName and hasProSubscription", async () => {
    const response = navAccountResponse(
      navAccountState({ displayName: "Ada", hasProSubscription: true }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { displayName: "Ada", hasProSubscription: true });
  });

  void test("the nav refreshes at most once a minute", () => {
    assert.equal(shouldRefreshNavAccount(null, 0), true);
    assert.equal(shouldRefreshNavAccount(1_000, 1_000 + NAV_ACCOUNT_REFRESH_MS - 1), false);
    assert.equal(shouldRefreshNavAccount(1_000, 1_000 + NAV_ACCOUNT_REFRESH_MS), true);
    assert.equal(NAV_ACCOUNT_REFRESH_MS, 60_000);
  });

  void test("the client parser accepts both shapes and rejects anything else", () => {
    assert.deepEqual(parseNavAccountState(ANONYMOUS_NAV_ACCOUNT), ANONYMOUS_NAV_ACCOUNT);
    assert.deepEqual(parseNavAccountState({ displayName: "Ada", hasProSubscription: false }), {
      displayName: "Ada",
      hasProSubscription: false,
    });
    assert.equal(parseNavAccountState({ displayName: 1, hasProSubscription: false }), null);
    assert.equal(parseNavAccountState({ displayName: "Ada" }), null);
    assert.equal(parseNavAccountState(null), null);
  });
});
