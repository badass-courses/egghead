// Mutation proof: removing the managed paid-through guard must break its contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const original = new URL("../apps/web/src/access/rails-access-delta.ts", import.meta.url);
const mutant = new URL(
  `../apps/web/src/access/rails-access-delta.mutant-${process.pid}.ts`,
  import.meta.url,
);
const source = await readFile(original, "utf8");
const needle = 'if (grant.source === "managed_subscription") {';
assert.equal(source.split(needle).length, 2, "mutation site must be unique");
await writeFile(
  mutant,
  source.replace(needle, 'if (grant.source === "managed_subscription" && false) {'),
  { flag: "wx" },
);
try {
  const check = `import assert from 'node:assert/strict'; import {partitionBackingGrants} from ${JSON.stringify(mutant.href)}; const result=partitionBackingGrants([{kind:'backing_grant',source:'managed_subscription',railsSourceId:'fixture-managed',railsUserId:'121',expiresAt:null,currentPeriodEnd:'2025-01-01',heldReason:'cancelled'}],new Set(['121']),Date.parse('2026-11-21T12:00:00Z')); assert.equal(result.live.length,0,'cancelled managed backing must never grant');`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", check],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cancelled managed backing must never grant/);
  console.log("PASS: managed guard removal killed by cancelled/past-period grant assertion");
} finally {
  await unlink(fileURLToPath(mutant));
}
