import assert from "node:assert/strict";
import { test } from "node:test";

import {
  unstable_doesMiddlewareMatch,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import nextConfig from "../../next.config";
import { GET as courseFeed } from "../../src/app/courses/[course]/course_feed/route";
import { GET as instructorFeed } from "../../src/app/instructors/[id]/feed/route";
import { GET as proFeed } from "../../src/app/lessons/pro_feed/route";
import { GET as playlistFeed } from "../../src/app/playlists/[id]/playlist_feed/route";
import { config, proxy } from "../../src/proxy";
import { serveLegacyShortLink } from "../../src/routing/legacy-short-links";
import { railsHostRoute } from "../../src/routing/rails-host";
import { resolveAppRoute } from "./route-table";

const legacyHost = "app.egghead.io";
const currentHost = "egghead.io";
const request = (path: string, method = "GET", host = legacyHost) =>
  new NextRequest(`https://${host}${path}`, { method, headers: { host } });

void test("Next reserves the legacy host for the host map, including trailing slashes", async () => {
  const path = "/users/123/?user_token=fake";
  await Promise.all(
    [legacyHost, currentHost].map(async (host) => {
      const url = `https://${host}${path}`;
      const headers = { host };
      const response = await unstable_getResponseFromNextConfig({ url, headers, nextConfig });
      assert.equal(response.status, host === legacyHost ? 200 : 308);
      assert.equal(
        unstable_doesMiddlewareMatch({ config, url, headers, nextConfig }),
        host === legacyHost,
      );
    }),
  );
  assert.equal(proxy(request(path, "GET", currentHost)).headers.get("x-middleware-next"), "1");
});

void test("legacy page redirects go straight to a real canonical route without credentials", () => {
  const pages = [
    ["/", "/"],
    ["/robots.txt", "/robots.txt"],
    ["/profile", "/profile"],
    ["/users/123/", "/profile"],
    ["/users/password/edit", "/login"],
    ["/users/sign_in", "/login"],
    ["/lessons/example-lesson", "/lessons/example-lesson"],
    ["/playlists/example-course", "/playlists/example-course"],
    ["/articles/example-article", "/blog/example-article"],
    ["/browse/lessons/javascript", "/q/javascript"],
    ["/search", "/q"],
  ] as const;
  for (const [from, to] of pages) {
    const response = proxy(request(`${from}?token=fake&next=https://example.test`, "HEAD"));
    assert.equal(response.status, 301, from);
    assert.equal(response.headers.get("location"), `https://egghead.io${to}`, from);
    assert.ok(resolveAppRoute(to), to);
  }
  assert.equal(proxy(request("/users/sign_in", "POST")).status, 405);
});

void test("public RSS aliases serve the existing CourseBuilder feed on the legacy host", () => {
  for (const path of ["/feed", "/feed.rss", "/lessons/feed", "/lessons/feed.rss"]) {
    assert.equal(proxy(request(path)).headers.get("x-middleware-next"), "1", path);
    assert.ok(["/feed", "/lessons/feed"].includes(resolveAppRoute(path) ?? ""), path);
    assert.equal(
      proxy(request(`${path}/`)).headers.get("x-middleware-rewrite"),
      `https://${legacyHost}${path}`,
    );
  }
});

void test("member feeds are gone on both hosts and no response repeats the token", () => {
  const feeds = [
    ["/lessons/pro_feed", proFeed],
    ["/courses/example/course_feed", courseFeed],
    ["/playlists/example/playlist_feed", playlistFeed],
    ["/instructors/example/feed", instructorFeed],
  ] as const;
  for (const [path, handler] of feeds) {
    assert.equal(resolveAppRoute(`${path}.rss`), resolveAppRoute(path));
    for (const response of [
      handler(),
      proxy(request(`${path}?user_token=fake`)),
      proxy(request(`${path}.rss?user_token=fake`, "HEAD")),
      proxy(request(`${path}.rss/?user_token=fake`)),
    ]) {
      assert.equal(response.status, 410, path);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.body, null);
    }
  }
});

void test("the short-link edge serves only reviewed public targets and never forwards query strings", async () => {
  const code = "abc123";
  const path = `/s/${code}`;
  const lookupPublicTarget = async (key: string) => {
    assert.equal(key, code);
    return "http://app.egghead.io/lessons/sample-lesson/";
  };
  const hit = await serveLegacyShortLink(request(`${path}?token=fake`, "HEAD"), {
    lookupPublicTarget,
  });
  assert.equal(hit?.status, 301);
  assert.equal(hit.headers.get("location"), "https://egghead.io/lessons/sample-lesson");
  assert.equal(hit.body, null);

  const reviewed = "https://example.test/public";
  const external = await serveLegacyShortLink(request(path), {
    lookupPublicTarget: async () => reviewed,
    allowedOffsiteTargets: new Set([reviewed]),
  });
  assert.equal(external?.headers.get("location"), reviewed);
  assert.equal(proxy(request(path)).status, 410, "origin has no private store");
});

void test("short-link misses and unapproved or credential-bearing targets are 410", async () => {
  const rejected = [
    undefined,
    { location: "https://egghead.io/lessons/sample" },
    "//egghead.io/lessons/sample",
    "https://user:password@egghead.io/lessons/sample",
    "https://egghead.io/lessons/sample?token=fake",
    "https://egghead.io/token/fake",
    "https://egghead.io/lessons/%2Fsample",
    "https://example.test/public",
    "https://example.test/public?token=fake",
  ];
  await Promise.all(
    rejected.map(async (target) => {
      const response = await serveLegacyShortLink(request("/s/abc123"), {
        lookupPublicTarget: async () => target,
        allowedOffsiteTargets: new Set(["https://example.test/public?token=fake"]),
      });
      assert.equal(response?.status, 410);
      assert.equal(response.headers.get("location"), null);
    }),
  );
});

void test("the short-link lookup stays on the legacy host and treats store outages as retryable", async () => {
  let calls = 0;
  const store = {
    lookupPublicTarget: async () => {
      calls += 1;
      throw new Error("not for the response");
    },
  };
  assert.equal(
    await serveLegacyShortLink(request("/s/abc123", "GET", currentHost), store),
    undefined,
  );
  assert.equal(await serveLegacyShortLink(request("/feed"), store), undefined);
  assert.equal((await serveLegacyShortLink(request("/s/%21"), store))?.status, 410);
  assert.equal((await serveLegacyShortLink(request("/s/abc123", "POST"), store))?.status, 405);
  assert.equal(calls, 0);
  const outage = await serveLegacyShortLink(request("/s/abc123"), store);
  assert.equal(outage?.status, 503);
  assert.equal(outage.headers.get("retry-after"), "300");
  assert.equal(outage.body, null);
  assert.equal(calls, 1);
});

void test("SAML stays pending; no permanent retirement or login substitute is shipped", () => {
  for (const path of ["/saml-login", "/saml-consume", "/saml_sessions/123/saml_metadata"]) {
    assert.deepEqual(railsHostRoute(path), { kind: "pending-saml" });
    const response = proxy(request(path));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  }
});

void test("Rails tokens and APIs never fall through to CourseBuilder", async () => {
  await Promise.all(
    ["/token/private-link", "/oauth/authorize", "/api/v1/users/send_token", "/graphql"].map(
      async (path) => {
        const response = proxy(request(`${path}?redirect_uri=https://example.test`));
        assert.equal(response.status, 410, path);
        assert.equal(response.headers.get("location"), null);
        assert.doesNotMatch(await response.text(), /private-link|example\.test/);
      },
    ),
  );
  for (const path of ["/stripe_events", "/api/auth/session", "/lessons/%2f%2fexample.test"]) {
    const response = proxy(request(path));
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("location"), null);
  }
});
