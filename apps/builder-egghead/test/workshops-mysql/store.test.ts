import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import mysql from "mysql2/promise";
import { Approval } from "@egghead/core/capability";
import {
  createWorkshop,
  getWorkshop,
  listWorkshops,
  updateWorkshop,
  WorkshopActor,
  WorkshopStore,
} from "@egghead/core/workshops";
import {
  workshopStoreLayer,
  assertLocalWorkshopRuntime,
} from "../../src/lib/workshops/mysql-store";

it.scoped(
  "native MySQL persists drafts, pages owners, preserves extra fields, and rejects concurrent revision writes",
  () =>
    Effect.gen(function* () {
      const databaseUrl = process.env["WORKSHOP_TEST_DATABASE_URL"];
      if (!databaseUrl)
        throw new Error("Set WORKSHOP_TEST_DATABASE_URL to an isolated local test database");
      assertLocalWorkshopRuntime(databaseUrl);
      const prefix = `workshoptest_${crypto.randomUUID().replaceAll("-", "")}`;
      const table = `\`${prefix}_ContentResource\``;
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => mysql.createConnection(databaseUrl)),
        (connection) => Effect.promise(() => connection.end()),
      );
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          fixture.execute(
            `CREATE TABLE ${table} (id varchar(255) PRIMARY KEY, type varchar(255) NOT NULL, createdById varchar(255) NOT NULL, fields json, createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL, INDEX type_idx(type), INDEX createdById_idx(createdById))`,
          ),
        ),
        () => Effect.promise(() => fixture.execute(`DROP TABLE ${table}`)),
      );
      const actor = Layer.succeed(WorkshopActor, {
        id: "instructor",
        canCreate: true,
        canManageAll: false,
        canManage: (workshop) => workshop.createdById === "instructor",
      });
      const approval = Layer.succeed(Approval, { require: () => Effect.void });
      const services = Layer.mergeAll(actor, approval, workshopStoreLayer(databaseUrl, prefix));
      const input = {
        requestId: crypto.randomUUID(),
        title: "Native live Workshop",
        description: "",
        startsAt: "2026-11-02T16:00:00Z",
        endsAt: "2026-11-02T18:00:00Z",
        timezone: "America/Denver",
        attendeeInstructions: "",
      };
      const created = yield* createWorkshop.run(input).pipe(Effect.provide(services));
      const reread = yield* getWorkshop.run({ id: created.id }).pipe(Effect.provide(services));
      expect(reread).toEqual(created);
      const duplicate = yield* Effect.flip(
        createWorkshop.run(input).pipe(Effect.provide(services)),
      );
      expect(duplicate.code).toBe("Conflict");
      yield* createWorkshop
        .run({ ...input, requestId: crypto.randomUUID() })
        .pipe(Effect.provide(services));
      yield* Effect.promise(() =>
        fixture.execute(
          `INSERT INTO ${table} (id, type, createdById, fields) VALUES (?, 'event', ?, ?), (?, 'workshop', ?, ?)`,
          [
            "unrelated-event",
            "instructor",
            JSON.stringify(created.fields),
            "unrelated-workshop",
            "another-owner",
            JSON.stringify(created.fields),
          ],
        ),
      );
      const first = yield* listWorkshops.run({ limit: 1 }).pipe(Effect.provide(services));
      expect(first.workshops).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = yield* listWorkshops
        .run({ limit: 1, cursor: first.nextCursor })
        .pipe(Effect.provide(services));
      expect(second.workshops).toHaveLength(1);
      expect(second.workshops[0]?.id).not.toBe(first.workshops[0]?.id);
      expect(second.nextCursor).toBeNull();
      yield* Effect.promise(() =>
        fixture.execute(
          `UPDATE ${table} SET fields = JSON_SET(fields, '$.integrationNote', 'preserve') WHERE id = ?`,
          [created.id],
        ),
      );
      const revised = {
        ...created,
        fields: { ...created.fields, title: "Concurrent revision", workshopRevision: 2 },
      };
      // Two independent connections both try the same expected revision. The UPDATE predicate owns concurrency.
      const results = yield* Effect.all(
        [0, 1].map(() =>
          Effect.gen(function* () {
            const store = yield* WorkshopStore;
            return yield* store.revise(revised, 1);
          }).pipe(Effect.provide(workshopStoreLayer(databaseUrl, prefix)), Effect.either),
        ),
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Right")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Left")).toHaveLength(1);
      const stale = yield* Effect.flip(
        updateWorkshop
          .run({ id: created.id, expectedRevision: 1, changes: { title: "Stale revision" } })
          .pipe(Effect.provide(services)),
      );
      expect(stale.code).toBe("Conflict");
      const [fields] = yield* Effect.promise(() =>
        fixture.execute<mysql.RowDataPacket[]>(
          `SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.integrationNote')) AS note FROM ${table} WHERE id = ?`,
          [created.id],
        ),
      );
      expect(fields[0]?.["note"]).toBe("preserve");
      const [plan] = yield* Effect.promise(() =>
        fixture.execute<mysql.RowDataPacket[]>(
          `EXPLAIN SELECT id, type, createdById, fields FROM ${table} WHERE id = ? AND type = 'workshop' AND deletedAt IS NULL LIMIT 1`,
          [created.id],
        ),
      );
      expect(plan[0]?.["key"]).toBe("PRIMARY");
      expect(plan[0]?.["type"]).toBe("const");
    }),
  20000,
);
