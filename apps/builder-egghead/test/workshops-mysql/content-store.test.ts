import { expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { mysqlTableCreator } from "drizzle-orm/mysql-core";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { DrizzleAdapter, type DrizzleAdapterComposition } from "@coursebuilder/adapter-drizzle";
import { getCourseBuilderSchema } from "@coursebuilder/adapter-drizzle/mysql";
import { Effect, Layer } from "effect";
import { Approval } from "@egghead/core/capability";
import { ContentActor, createDraft, getPost, listPosts, updateDraft } from "@egghead/core/content";
import { assertLocalWorkshopRuntime } from "../../src/lib/workshops/mysql-store";
import {
  contentStoreLayer,
  type ContentPersistence,
  type StoredPost,
} from "../../src/lib/content/store";
import { draftWrite } from "../../src/lib/content/draft-write";

function fromRow(
  row: ReturnType<typeof getCourseBuilderSchema>["contentResource"]["$inferSelect"],
): StoredPost {
  return { ...row, fields: row.fields ?? {} };
}

it("content contract persists CourseBuilder drafts and atomically appends audit on MySQL", async () => {
  const url = process.env["WORKSHOP_TEST_DATABASE_URL"];
  if (!url) throw new Error("Set WORKSHOP_TEST_DATABASE_URL to an isolated local test database");
  assertLocalWorkshopRuntime(url);
  const prefix = `ct_${crypto.randomUUID().replaceAll("-", "")}`;
  const tableFn = mysqlTableCreator((name) => `${prefix}_${name}`);
  const schema = getCourseBuilderSchema(tableFn);
  const connection = await mysql.createConnection(url);
  const database = drizzle(connection, { schema, mode: "default" });
  // Published SqlFlavorOptions omits MySqlDatabase's relational-schema generic,
  // defaulting it to an empty schema. Runtime supports this schema-bearing client.
  // Isolate that type mismatch to one port; the adapter validates its output with
  // ContentResourceSchema. No dependency types or production config are weakened.
  const adapter = (
    DrizzleAdapter as unknown as (
      client: typeof database,
      factory: typeof tableFn,
    ) => Pick<DrizzleAdapterComposition, "createContentResource">
  )(database, tableFn);
  const table = schema.contentResource;
  const createdTables: string[] = [];
  const persistence: ContentPersistence = {
    read: async (id) => {
      const row = await database.query.contentResource.findFirst({ where: eq(table.id, id) });
      return row ? fromRow(row) : null;
    },
    list: async ({ limit, cursor, ownerId }) =>
      (
        await database
          .select()
          .from(table)
          .where(
            and(
              eq(table.type, "post"),
              isNull(table.deletedAt),
              cursor ? gt(table.id, cursor) : undefined,
              ownerId ? eq(table.createdById, ownerId) : undefined,
            ),
          )
          .orderBy(asc(table.id))
          .limit(limit + 1)
      ).map(fromRow),
    create: async (post) => adapter.createContentResource(post),
    compareAndSwap: async (current, changes, audit) => {
      const write = draftWrite(table, current, changes, audit);
      const [result] = await database.update(table).set(write.values).where(write.where);
      return result.affectedRows === 1;
    },
  };
  try {
    await [
      [
        "ContentResource",
        "id varchar(255) PRIMARY KEY, organizationId varchar(191), createdByOrganizationMembershipId varchar(191), type varchar(255) NOT NULL, createdById varchar(255) NOT NULL, fields json, slug varchar(255) GENERATED ALWAYS AS (fields->>'$.slug') STORED, currentVersionId varchar(255), createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), updatedAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), deletedAt timestamp(3) NULL",
      ],
      [
        "ContentResourceResource",
        "resourceOfId varchar(255), resourceId varchar(255), position double DEFAULT 0, metadata json, organizationId varchar(191), createdAt timestamp(3) NULL, updatedAt timestamp(3) NULL, deletedAt timestamp(3) NULL, PRIMARY KEY(resourceOfId, resourceId)",
      ],
    ].reduce(
      (previous, [name, columns]) =>
        previous.then(async () => {
          const nameWithPrefix = `${prefix}_${name}`;
          await connection.execute(`CREATE TABLE \`${nameWithPrefix}\` (${columns})`);
          createdTables.push(nameWithPrefix);
          return undefined;
        }),
      Promise.resolve(),
    );
    const actor = Layer.succeed(ContentActor, {
      userId: "author",
      tokenId: "synthetic-hash",
      actorLabel: "test-agent",
      canCreate: true,
      canManageAll: false,
      canRead: (post) => post.createdById === "author",
      canManage: (post) => post.createdById === "author",
    });
    const services = Layer.mergeAll(
      actor,
      contentStoreLayer(persistence),
      Layer.succeed(Approval, { require: () => Effect.void }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* createDraft.run({
          title: "MySQL draft",
          body: "Original",
          postType: "lesson",
          fields: {},
        });
        expect((yield* getPost.run({ id: created.id })).fields.state).toBe("draft");
        const edited = yield* updateDraft.run({
          id: created.id,
          title: "Edited draft",
          body: "Edited",
          fields: { description: "Description" },
        });
        expect((yield* getPost.run({ id: created.id })).fields).toEqual(edited.fields);
        expect((yield* listPosts.run({ limit: 1 })).posts).toHaveLength(1);
        const snapshot = yield* Effect.promise(() => persistence.read(created.id));
        if (!snapshot) throw new Error("Missing draft");
        expect(snapshot.fields["contentMcpAudit"]).toEqual([
          expect.objectContaining({
            userId: "author",
            actorLabel: "test-agent",
            tokenId: "synthetic-hash",
          }),
          expect.objectContaining({
            userId: "author",
            actorLabel: "test-agent",
            tokenId: "synthetic-hash",
          }),
        ]);
        const audit = {
          userId: "author",
          actorLabel: "test-agent",
          tokenId: "synthetic-hash",
          at: new Date().toISOString(),
        };
        expect(
          yield* Effect.promise(() =>
            persistence.compareAndSwap(snapshot, { title: "Winner" }, audit),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            persistence.compareAndSwap(snapshot, { title: "Stale loser" }, audit),
          ),
        ).toBe(false);
        yield* Effect.promise(() =>
          database
            .update(table)
            .set({ fields: { ...snapshot.fields, state: "published" } })
            .where(eq(table.id, created.id)),
        );
        expect(
          yield* Effect.either(updateDraft.run({ id: created.id, body: "Must not edit" })),
        ).toMatchObject({ _tag: "Left", left: { code: "Conflict" } });
      }).pipe(Effect.provide(services)),
    );
  } finally {
    await Promise.all(createdTables.map((name) => connection.execute(`DROP TABLE \`${name}\``)));
    await connection.end();
  }
}, 20000);
