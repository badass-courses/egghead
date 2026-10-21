import assert from "node:assert/strict";
import {
  localWorkshopConnection,
  canPreviewLocalWorkshops,
  listLocalWorkshops,
  getLocalWorkshop,
} from "../apps/web/src/workshops/local-preview";

const keys = ["NODE_ENV", "EGGHEAD_RUNTIME", "WORKSHOP_MCP_URL", "WORKSHOP_MCP_TOKEN"] as const;

const originalFetch = globalThis.fetch;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  Object.assign(process.env, {
    NODE_ENV: "development",
    EGGHEAD_RUNTIME: "local",
    WORKSHOP_MCP_URL: "http://127.0.0.1:3010/api/workshop-mcp",
    WORKSHOP_MCP_TOKEN: crypto.randomUUID(),
  });
  assert.ok(localWorkshopConnection());
  for (const runtime of ["beta", "production"]) {
    process.env["EGGHEAD_RUNTIME"] = runtime;
    assert.equal(localWorkshopConnection(), null, `${runtime} must not expose local drafts`);
  }
  process.env["EGGHEAD_RUNTIME"] = "local";
  Object.assign(process.env, { NODE_ENV: "production" });
  assert.equal(localWorkshopConnection(), null, "Production builds must not expose drafts");
  Object.assign(process.env, { NODE_ENV: "development" });
  for (const url of [
    "invalid-url",
    "https://example.com/api/workshop-mcp",
    "http://127.0.0.1.example.com/api/workshop-mcp",
    "http://127.0.0.1:3010/api/mcp",
    "http://user@127.0.0.1:3010/api/workshop-mcp",
    "http://127.0.0.1:3010/api/workshop-mcp?redirect=remote",
  ]) {
    process.env["WORKSHOP_MCP_URL"] = url;
    assert.equal(localWorkshopConnection(), null, "Only the loopback Workshop endpoint is allowed");
  }
  process.env["WORKSHOP_MCP_URL"] = "http://127.0.0.1:3010/api/workshop-mcp";
  delete process.env["WORKSHOP_MCP_TOKEN"];
  assert.equal(localWorkshopConnection(), null, "Credentials must remain server-configured");
  process.env["WORKSHOP_MCP_TOKEN"] = crypto.randomUUID();
  const owner = { id: "synthetic-instructor", role: "contributor" };
  const admin = { id: "synthetic-admin", role: "admin" };
  const draft = {
    id: `workshop~${crypto.randomUUID()}`,
    type: "workshop",
    createdById: owner.id,
    fields: {
      title: "Synthetic Workshop",
      slug: "synthetic-workshop",
      description: "",
      startsAt: "2099-11-01T17:00:00.000Z",
      endsAt: "2099-11-01T23:00:00.000Z",
      timezone: "America/Los_Angeles",
      attendeeInstructions: "",
      state: "draft",
      visibility: "unlisted",
      workshopRevision: 1,
    },
  };
  const foreign = {
    ...draft,
    id: `workshop~${crypto.randomUUID()}`,
    createdById: "another-instructor",
  };
  let calls = 0;
  let payload: unknown = draft;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ result: { structuredContent: payload, content: [] } });
  };
  const deniedViewers = [null, { id: "synthetic-learner", role: "user" }];
  deniedViewers.forEach((viewer) => assert.equal(canPreviewLocalWorkshops(viewer), false));
  await Promise.all(
    deniedViewers.flatMap((viewer) => [
      assert.rejects(listLocalWorkshops(viewer), { code: "Unauthorized" }),
      assert.rejects(getLocalWorkshop(draft.id, viewer), { code: "Unauthorized" }),
    ]),
  );
  assert.equal(calls, 0, "Unauthorized requests must never use the MCP bearer credential");
  assert.equal(canPreviewLocalWorkshops(owner), true);
  assert.equal(canPreviewLocalWorkshops(admin), true);
  assert.equal((await getLocalWorkshop(draft.id, owner))?.id, draft.id);
  payload = foreign;
  assert.equal(await getLocalWorkshop(foreign.id, owner), null);
  assert.equal((await getLocalWorkshop(foreign.id, admin))?.id, foreign.id);
  payload = { workshops: [draft, foreign], nextCursor: null };
  assert.deepEqual(
    (await listLocalWorkshops(owner)).workshops.map((w) => w.id),
    [draft.id],
  );
  assert.equal((await listLocalWorkshops(admin)).workshops.length, 2);
  console.log(
    "Workshop preview guards passed: development/local, loopback endpoint, authenticated staff and owner scope.",
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
}
