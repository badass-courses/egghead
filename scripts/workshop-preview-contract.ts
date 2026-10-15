import assert from "node:assert/strict";
import { localWorkshopConnection } from "../apps/web/src/workshops/local-preview";

const keys = ["NODE_ENV", "EGGHEAD_RUNTIME", "WORKSHOP_MCP_URL", "WORKSHOP_MCP_TOKEN"] as const;
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
  console.log(
    "Workshop preview guards passed: development/local only, loopback endpoint, credential required.",
  );
} finally {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
}
