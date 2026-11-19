// Guards for real 404s on content routes.
//
// Root cause (2026-11-19): under cacheComponents, notFound() on a
// generateStaticParams route renders in Next's legacy prerender store. A
// session read in the root layout there sets revalidate to 0, and Next 16.2
// answers 500. A loading.tsx above the page lets the shell stream first, so
// the 404 becomes a soft 200. HTTP status proof against a running server is
// scripts/not-found-status-smoke.ts.

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANONYMOUS_NAV_ACCOUNT,
  navAccountResponse,
  navAccountState,
  parseNavAccountState,
} from "../../src/coursebuilder/nav-account";

const appDir = fileURLToPath(new URL("../../src/app", import.meta.url));

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const SERVER_SESSION_READ =
  /from "(?:next\/headers|[./]*(?:server\/auth|coursebuilder\/current-user))"/;

void describe("root layout tree stays free of server session reads", () => {
  void test("the layout imports nothing that reads cookies or the session", async () => {
    const layout = await readFile(path.join(appDir, "layout.tsx"), "utf8");
    assert.doesNotMatch(layout, SERVER_SESSION_READ);
  });

  void test("the account nav is a client component", async () => {
    const nav = await readFile(path.join(appDir, "site-nav-with-account.tsx"), "utf8");
    assert.ok(
      nav.startsWith('"use client";'),
      "site-nav-with-account.tsx must stay a client component",
    );
    assert.doesNotMatch(nav, SERVER_SESSION_READ);
  });

  void test("collection entries have no loading.tsx that would turn 404s into soft 200s", async () => {
    assert.equal(await exists(path.join(appDir, "[slug]", "[entry]", "loading.tsx")), false);
    assert.equal(await exists(path.join(appDir, "[slug]", "loading.tsx")), false);
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
