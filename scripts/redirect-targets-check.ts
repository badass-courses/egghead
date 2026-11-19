// Checks that every hardcoded redirect target answers 200 on a running site.
//
//   pnpm routing:redirect-targets --base https://beta.egghead.io
//
// The parity test proves a target matches an app route, but /[slug] matches
// any slug. This asks the real site: each LEGACY_REDIRECTS destination with no
// :param is fetched once (GET, no redirect following) and must answer 200.
// Destinations built from params (/courses/:slug, /q/:topic) depend on the
// incoming URL and are not checked here. Read-only; exits non-zero on any miss.

import { parseArgs } from "node:util";

import { LEGACY_REDIRECTS } from "../apps/web/src/routing/legacy-redirects";

const { values } = parseArgs({
  options: { base: { type: "string", default: "https://beta.egghead.io" } },
});

const targets = new Map<string, string[]>();
for (const rule of LEGACY_REDIRECTS) {
  if (rule.destination.includes(":")) continue;
  targets.set(rule.destination, [...(targets.get(rule.destination) ?? []), rule.id]);
}

const results = await Promise.all(
  [...targets].map(async ([destination, rules]) => {
    const response = await fetch(new URL(destination, values.base), { redirect: "manual" });
    await response.arrayBuffer();
    return {
      destination,
      rules,
      status: response.status,
      location: response.headers.get("location"),
    };
  }),
);
const misses = results.filter((result) => result.status !== 200);

console.log(
  JSON.stringify(
    { ok: misses.length === 0, base: values.base, checked: results.length, misses },
    null,
    2,
  ),
);
if (misses.length > 0) process.exitCode = 1;
