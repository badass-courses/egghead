import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";

it.scoped(
  "device authentication honors roles, expiry, and revocation before HTTP persists a Workshop",
  () =>
    Effect.gen(function* () {
      const databaseUrl = process.env["WORKSHOP_TEST_DATABASE_URL"];
      if (!databaseUrl)
        throw new Error("Set WORKSHOP_TEST_DATABASE_URL to an isolated local test database");
      const prefix = `workshopauth_${crypto.randomUUID().replaceAll("-", "")}`;
      const original = {
        runtime: process.env["EGGHEAD_RUNTIME"],
        database: process.env["DATABASE_URL"],
        prefix: process.env["NEXT_PUBLIC_APP_NAME"],
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env["EGGHEAD_RUNTIME"] = "local";
          process.env["DATABASE_URL"] = databaseUrl;
          process.env["NEXT_PUBLIC_APP_NAME"] = prefix;
        }),
        () =>
          Effect.sync(() => {
            for (const [key, value] of [
              ["EGGHEAD_RUNTIME", original.runtime],
              ["DATABASE_URL", original.database],
              ["NEXT_PUBLIC_APP_NAME", original.prefix],
            ]) {
              if (key) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }
          }),
      );
      const connection = yield* Effect.acquireRelease(
        Effect.promise(() => mysql.createConnection(databaseUrl)),
        (connected) => Effect.promise(() => connected.end()),
      );
      const definitions = [
        [
          "User",
          "id varchar(255) PRIMARY KEY, name varchar(255), role varchar(191) DEFAULT 'user', email varchar(255) NOT NULL, fields json, legacyRailsUserId varchar(255), legacyContactId varchar(255), emailVerified timestamp(3) NULL, image varchar(255), createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3)",
        ],
        [
          "Role",
          "id varchar(255) PRIMARY KEY, organizationId varchar(191), name varchar(255), description text, active boolean DEFAULT true, createdAt timestamp(3) NULL, updatedAt timestamp(3) NULL, deletedAt timestamp(3) NULL",
        ],
        [
          "UserRole",
          "userId varchar(255), roleId varchar(255), active boolean DEFAULT true, organizationId varchar(191), createdAt timestamp(3) NULL, updatedAt timestamp(3) NULL, deletedAt timestamp(3) NULL, PRIMARY KEY(userId, roleId)",
        ],
        [
          "DeviceAccessToken",
          "token varchar(191) PRIMARY KEY, userId varchar(191), organizationMembershipId varchar(191), scope varchar(191), createdAt timestamp(3) NULL, expiresAt timestamp(3) NULL, revokedAt timestamp(3) NULL",
        ],
        [
          "ContentResource",
          "id varchar(255) PRIMARY KEY, type varchar(255) NOT NULL, createdById varchar(255) NOT NULL, fields json, createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL",
        ],
      ] as const;
      for (const [name, definition] of definitions) {
        yield* Effect.acquireRelease(
          Effect.promise(() =>
            connection.execute(`CREATE TABLE \`${prefix}_${name}\` (${definition})`),
          ),
          () => Effect.promise(() => connection.execute(`DROP TABLE \`${prefix}_${name}\``)),
        );
      }
      const userId = crypto.randomUUID();
      const token = crypto.randomUUID();
      yield* Effect.promise(() =>
        connection.execute(
          `INSERT INTO \`${prefix}_User\` (id, name, email, fields) VALUES (?, 'Local Test Instructor', ?, '{}')`,
          [userId, `${userId}@example.invalid`],
        ),
      );
      yield* Effect.promise(() =>
        connection.execute(
          `INSERT INTO \`${prefix}_Role\` (id, name, active) VALUES ('instructor', 'contributor', true)`,
        ),
      );
      yield* Effect.promise(() =>
        connection.execute(
          `INSERT INTO \`${prefix}_UserRole\` (userId, roleId) VALUES (?, 'instructor')`,
          [userId],
        ),
      );
      yield* Effect.promise(() =>
        connection.execute(
          `INSERT INTO \`${prefix}_DeviceAccessToken\` (token, userId, expiresAt) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
          [token, userId],
        ),
      );
      const { localWorkshopActor } = yield* Effect.promise(
        () => import("../../src/lib/workshops/local-actor"),
      );
      const { POST } = yield* Effect.promise(() => import("../../src/app/api/workshop-mcp/route"));
      expect(
        yield* Effect.promise(() => localWorkshopActor(databaseUrl, `Bearer ${token}`)),
      ).toMatchObject({ id: userId, canCreate: true, canManageAll: false });
      const requestId = crypto.randomUUID();
      const response = yield* Effect.promise(() =>
        POST(
          new NextRequest("http://localhost:3000/api/workshop-mcp", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2025-11-25",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "create_workshop",
                arguments: {
                  requestId,
                  title: "HTTP Workshop",
                  description: "",
                  startsAt: "2026-11-02T16:00:00Z",
                  endsAt: "2026-11-02T18:00:00Z",
                  timezone: "America/Denver",
                  attendeeInstructions: "",
                  confirm: true,
                },
              },
            }),
          }),
        ),
      );
      expect(response.status).toBe(200);
      const body: unknown = yield* Effect.promise(() => response.json());
      expect(body).toMatchObject({
        result: {
          structuredContent: { id: `workshop~${requestId}`, type: "workshop", createdById: userId },
        },
      });
      yield* Effect.promise(() =>
        connection.execute(
          `UPDATE \`${prefix}_DeviceAccessToken\` SET revokedAt = NOW() WHERE token = ?`,
          [token],
        ),
      );
      expect(
        yield* Effect.promise(() => localWorkshopActor(databaseUrl, `Bearer ${token}`)),
      ).toBeNull();
      yield* Effect.promise(() =>
        connection.execute(
          `UPDATE \`${prefix}_DeviceAccessToken\` SET revokedAt = NULL, expiresAt = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE token = ?`,
          [token],
        ),
      );
      expect(
        yield* Effect.promise(() => localWorkshopActor(databaseUrl, `Bearer ${token}`)),
      ).toBeNull();
      yield* Effect.promise(() =>
        connection.execute(
          `UPDATE \`${prefix}_DeviceAccessToken\` SET expiresAt = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE token = ?`,
          [token],
        ),
      );
      yield* Effect.promise(() =>
        connection.execute(`UPDATE \`${prefix}_UserRole\` SET active = false WHERE userId = ?`, [
          userId,
        ]),
      );
      expect(
        yield* Effect.promise(() => localWorkshopActor(databaseUrl, `Bearer ${token}`)),
      ).toBeNull();
    }),
  20000,
);
