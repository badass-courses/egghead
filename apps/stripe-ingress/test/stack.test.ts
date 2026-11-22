import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WORKER_NAME } from "../infra/cloudflare-api.js";

const scan = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? scan(path.join(directory, entry.name))
          : [await readFile(path.join(directory, entry.name), "utf8")],
      ),
    )
  ).flat();
};

await test(
  "real Alchemy CLI plans/applies/destroys only against a local API mock with local state",
  { timeout: 120_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "egghead-ingress-stack-"));
    const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.resolve("alchemy")));
    const stack = fileURLToPath(new URL("../alchemy.run.ts", import.meta.url));
    const accountId = "a".repeat(32);
    const prefix = `/client/v4/accounts/${accountId}/workers`;
    const script = `${prefix}/scripts/${WORKER_NAME}`;
    const serviceSubdomain = `${prefix}/services/${WORKER_NAME}/environments/production/subdomain`;
    const calls: string[] = [];
    let live = false;
    const server = createServer((request, response) => {
      const call = `${request.method} ${request.url}`;
      calls.push(call);
      request.resume();
      response.setHeader("content-type", "application/json");
      switch (call) {
        case `GET ${script}`:
          response.writeHead(live ? 200 : 404).end(JSON.stringify({ success: live }));
          break;
        case `PUT ${script}`:
          live = true;
          response.end(JSON.stringify({ success: true, result: { id: WORKER_NAME } }));
          break;
        case `POST ${serviceSubdomain}`:
          response.end(
            JSON.stringify({ success: true, result: { enabled: true, previews_enabled: false } }),
          );
          break;
        case `GET ${prefix}/subdomain`:
          response.end(JSON.stringify({ success: true, result: { subdomain: "fleet-test" } }));
          break;
        case `DELETE ${script}`:
          live = false;
          response.end(JSON.stringify({ success: true, result: null }));
          break;
        default:
          response.writeHead(403).end(JSON.stringify({ success: false }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const nonce = "synthetic-stack-forward-nonce-00000000";
    const upstream = "https://beta.egghead.io/api/stripe/subscription-shadow";
    const run = async (
      command: string,
      options: { upstreamUrl?: string; force?: boolean } = {},
    ): Promise<string> => {
      const child = spawn(
        process.execPath,
        [
          cli,
          command,
          "--config",
          stack,
          "--stage",
          "mock",
          "--no-input",
          ...(command === "plan" ? [] : ["--yes"]),
          ...(options.force ? ["--force"] : []),
        ],
        {
          cwd,
          env: {
            ...process.env,
            ALCHEMY_TELEMETRY_DISABLED: "1",
            CLOUDFLARE_ACCOUNT_ID: accountId,
            SHADOW_UPSTREAM_URL: options.upstreamUrl ?? upstream,
            SC_FORWARD_URL: `http://127.0.0.1:${address.port}`,
            SC_FORWARD_NONCE: nonce,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code] = await once(child, "close");
      if (code !== 0) throw new Error(`${command} failed (${String(code)}): ${output}`);
      return output;
    };
    try {
      const hostError = /SHADOW_UPSTREAM_URL must be https:\/\/beta\.egghead\.io/;
      await assert.rejects(
        run("plan", { upstreamUrl: "https://egghead.io/api/stripe/subscription-shadow" }),
        hostError,
      );
      await assert.rejects(
        run("plan", { upstreamUrl: "https://attacker.example/api/stripe/subscription-shadow" }),
        hostError,
      );
      await assert.rejects(
        run("plan", {
          upstreamUrl: "https://beta.egghead.io.attacker.example/api/stripe/subscription-shadow",
        }),
        hostError,
      );
      await assert.rejects(
        run("plan", { upstreamUrl: "https://beta.egghead.io:8443/api/stripe/subscription-shadow" }),
        hostError,
      );
      assert.equal(
        calls.length,
        0,
        "invalid upstream hosts must fail before any Cloudflare API call",
      );
      await run("plan");
      assert.equal(live, false);
      await run("deploy");
      assert.equal(live, true);
      const afterDeploy = calls.length;
      await run("plan");
      assert.equal(
        calls.slice(afterDeploy).some((call) => call.startsWith("PUT") || call.startsWith("POST")),
        false,
      );
      const beforeUpdate = calls.filter((call) => call.startsWith("PUT")).length;
      await run("deploy", { force: true });
      assert.equal(calls.filter((call) => call.startsWith("PUT")).length, beforeUpdate + 1);
      const allowed = new Set([
        `GET ${script}`,
        `PUT ${script}`,
        `DELETE ${script}`,
        `POST ${serviceSubdomain}`,
        `GET ${prefix}/subdomain`,
      ]);
      for (const call of calls) assert.ok(allowed.has(call), `unexpected API ${call}`);
      const state = path.join(cwd, ".alchemy", "state");
      assert.ok((await readdir(state)).length > 0);
      const contents = await scan(state);
      for (const value of contents) {
        assert.equal(value.includes(nonce), false);
        assert.equal(value.includes("{{secret:"), false);
      }
      await run("destroy");
      assert.equal(live, false);
      for (const call of calls) assert.ok(allowed.has(call), `unexpected API ${call}`);
    } finally {
      server.close();
      await once(server, "close");
    }
  },
);
