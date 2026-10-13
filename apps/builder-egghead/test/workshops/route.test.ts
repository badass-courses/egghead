import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "../../src/app/api/workshop-mcp/route";

it.effect(
  "HTTP refuses a missing bearer locally and blocks nonlocal runtimes before authentication",
  () =>
    Effect.tryPromise(async () => {
      const runtime = process.env["EGGHEAD_RUNTIME"];
      const database = process.env["DATABASE_URL"];
      try {
        process.env["EGGHEAD_RUNTIME"] = "local";
        process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
        const request = new NextRequest("http://localhost:3000/api/workshop-mcp", {
          method: "POST",
        });
        const unauthorized = await POST(request);
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get("WWW-Authenticate")).toContain("Bearer");
        process.env["EGGHEAD_RUNTIME"] = "production";
        expect((await POST(request)).status).toBe(403);
        process.env["EGGHEAD_RUNTIME"] = "beta";
        expect((await POST(request)).status).toBe(403);
        expect(GET().status).toBe(405);
        expect(DELETE().headers.get("Allow")).toBe("POST");
      } finally {
        if (runtime === undefined) delete process.env["EGGHEAD_RUNTIME"];
        else process.env["EGGHEAD_RUNTIME"] = runtime;
        if (database === undefined) delete process.env["DATABASE_URL"];
        else process.env["DATABASE_URL"] = database;
      }
    }),
);
