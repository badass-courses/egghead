// HTTP status smoke for content 404s against a running egghead web server.
//
//   pnpm routing:not-found:smoke --base http://127.0.0.1:3019 \
//     --known /some-course --known /some-course/some-lesson \\
//     --unknown /some-course/missing-lesson
//
// Unknown content URLs must answer a real 404 (not 500, not a soft 200).
// Known URLs must still answer 200. Exits non-zero on any mismatch and prints
// a JSON table.

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3008" },
    known: { type: "string", multiple: true, default: [] },
    unknown: { type: "string", multiple: true, default: [] },
  },
});

const UNKNOWN_PATHS = [
  "/zz-route-parity-missing",
  "/zz-route-parity-missing/zz-entry",
  "/courses/zz-route-parity-missing",
  "/lessons/zz-route-parity-missing",
  "/talks/zz-route-parity-missing",
  "/podcasts/zz-route-parity-missing",
];

type Row = { path: string; expected: number; status: number; ok: boolean };

async function status(pathname: string) {
  const response = await fetch(new URL(pathname, values.base), { redirect: "manual" });
  await response.arrayBuffer();
  return response.status;
}

const checks = [
  ...[...UNKNOWN_PATHS, ...values.unknown].map((pathname) => ({ pathname, expected: 404 })),
  ...values.known.map((pathname) => ({ pathname, expected: 200 })),
];

const rows: Row[] = await Promise.all(
  checks.map(async ({ pathname, expected }) => {
    const actual = await status(pathname);
    return { path: pathname, expected, status: actual, ok: actual === expected };
  }),
);

const ok = rows.every((row) => row.ok);
console.log(JSON.stringify({ ok, base: values.base, rows }, null, 2));
if (!ok) process.exitCode = 1;
