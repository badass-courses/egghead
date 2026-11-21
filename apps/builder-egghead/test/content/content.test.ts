import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Approval } from "@egghead/core/capability";
import { ContentActor, createDraft, getPost, listPosts, updateDraft } from "@egghead/core/content";
import {
  contentStoreLayer,
  type ContentPersistence,
  type StoredPost,
} from "../../src/lib/content/store";
import { buildContentMcpServer } from "../../src/lib/content/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppAbility } from "../../src/ability";
import { contentActor } from "../../src/lib/content/actor";

export function memoryPersistence() {
  const rows = new Map<string, StoredPost>();
  const persistence: ContentPersistence = {
    read: async (id) => rows.get(id) ?? null,
    list: async ({ limit, cursor, ownerId }) =>
      [...rows.values()]
        .filter(
          (post) =>
            !post.deletedAt &&
            post.type === "post" &&
            (!ownerId || post.createdById === ownerId) &&
            (!cursor || post.id > cursor),
        )
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit + 1),
    create: async (post) => {
      rows.set(post.id, structuredClone(post));
    },
    compareAndSwap: async (snapshot, changes, audit) => {
      const current = rows.get(snapshot.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) return false;
      const history = current.fields["contentMcpAudit"];
      rows.set(current.id, {
        ...current,
        fields: {
          ...current.fields,
          ...changes,
          contentMcpAudit: [...(Array.isArray(history) ? history : []), audit],
        },
      });
      return true;
    },
  };
  return { persistence, rows };
}
const actor = ContentActor.of({
  userId: "author",
  tokenId: "token-hash",
  actorLabel: "test-agent",
  canList: true,
  canCreate: true,
  canManageAll: false,
  canRead: (post) => post.createdById === "author",
  canManage: (post) => post.createdById === "author",
});
const approval = Layer.succeed(Approval, { require: () => Effect.void });
const input = {
  title: "A draft",
  body: "Original body",
  postType: "lesson",
  fields: { description: "Description" },
};

describe("content contract over an in-memory store", () => {
  it("creates, lists, edits and reads native drafts with atomic write attribution", async () => {
    const { persistence, rows } = memoryPersistence();
    const services = Layer.mergeAll(
      contentStoreLayer(persistence),
      Layer.succeed(ContentActor, actor),
      approval,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* createDraft.run(input);
        expect(created.fields.state).toBe("draft");
        expect((yield* listPosts.run({ limit: 1 })).posts).toEqual([created]);
        const edited = yield* updateDraft.run({
          id: created.id,
          title: "Edited draft",
          body: "Edited body",
          fields: { summary: "Summary" },
        });
        expect(edited.fields.description).toBe("Description");
        expect((yield* getPost.run({ id: created.id })).fields).toMatchObject({
          title: "Edited draft",
          body: "Edited body",
          state: "draft",
        });
        expect(rows.get(created.id)?.fields["contentMcpAudit"]).toEqual([
          expect.objectContaining({
            userId: "author",
            tokenId: "token-hash",
            actorLabel: "test-agent",
          }),
          expect.objectContaining({
            userId: "author",
            tokenId: "token-hash",
            actorLabel: "test-agent",
          }),
        ]);
      }).pipe(Effect.provide(services)),
    );
  });
  it("rejects state, access, ownership, tags and integration IDs before touching storage", async () => {
    const { persistence, rows } = memoryPersistence();
    const services = Layer.mergeAll(
      contentStoreLayer(persistence),
      Layer.succeed(ContentActor, actor),
      approval,
    );
    await Promise.all(
      [
        { state: "published" },
        { visibility: "public" },
        { access: "free" },
        { createdById: "other" },
        { tags: [] },
        { eggheadLessonId: 1 },
      ].map(async (fields) => {
        const result = await Effect.runPromise(
          createDraft.run({ ...input, fields }).pipe(Effect.provide(services), Effect.either),
        );
        expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidInput" } });
      }),
    );
    expect(rows.size).toBe(0);
  });
  it("does not edit published, deleted, foreign or concurrently changed posts", async () => {
    const { persistence, rows } = memoryPersistence();
    const services = Layer.mergeAll(
      contentStoreLayer(persistence),
      Layer.succeed(ContentActor, actor),
      approval,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* createDraft.run(input);
        const original = rows.get(created.id);
        if (!original) throw new Error("Missing fixture");
        for (const post of [
          { ...original, fields: { ...original.fields, state: "published" } },
          { ...original, deletedAt: new Date() },
          { ...original, createdById: "other" },
        ]) {
          rows.set(created.id, post);
          if (post.createdById === "other") {
            expect(yield* Effect.either(getPost.run({ id: created.id }))).toMatchObject({
              _tag: "Left",
              left: { code: "NotFound" },
            });
            expect((yield* listPosts.run({ limit: 10 })).posts).toEqual([]);
          }
          expect(
            yield* Effect.either(updateDraft.run({ id: created.id, title: "Forbidden" })),
          ).toMatchObject({ _tag: "Left" });
        }
        rows.set(created.id, original);
        const conflicting = contentStoreLayer({
          ...persistence,
          compareAndSwap: async () => false,
        });
        expect(
          yield* updateDraft
            .run({ id: created.id, title: "Racing" })
            .pipe(Effect.provide(conflicting), Effect.either),
        ).toMatchObject({ _tag: "Left", left: { code: "Conflict" } });
        expect(rows.get(created.id)).toEqual(original);
      }).pipe(Effect.provide(services)),
    );
  });
  it("denies creation without create Content and does not expose a foreign post", async () => {
    const { persistence } = memoryPersistence();
    const services = Layer.mergeAll(
      contentStoreLayer(persistence),
      Layer.succeed(ContentActor, { ...actor, canCreate: false }),
      approval,
    );
    const result = await Effect.runPromise(
      createDraft.run(input).pipe(Effect.provide(services), Effect.either),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "Unauthorized" } });
  });
  it.each(["manage-only", "read-only", "no-permission"] as const)(
    "checks each operation for a %s identity",
    async (mode) => {
      const { persistence, rows } = memoryPersistence();
      const store = contentStoreLayer(persistence);
      const writer = Layer.mergeAll(store, Layer.succeed(ContentActor, actor), approval);
      const created = await Effect.runPromise(createDraft.run(input).pipe(Effect.provide(writer)));
      const ability = createAppAbility(
        mode === "manage-only"
          ? [
              {
                action: "manage",
                subject: "Content",
                conditions: { createdById: { $eq: "author" } },
              },
              { action: "create", subject: "Content", inverted: true },
            ]
          : mode === "read-only"
            ? [{ action: "read", subject: "Content" }]
            : [],
      );
      const authenticated = contentActor(
        { user: { id: "author", name: null, roles: [] }, ability, tokenId: "token-hash" },
        "test-agent",
      );
      if (!authenticated) throw new Error("A valid identity must not require create permission");
      const services = Layer.mergeAll(store, Layer.succeed(ContentActor, authenticated), approval);
      await Effect.runPromise(
        Effect.gen(function* () {
          expect(yield* Effect.either(createDraft.run(input))).toMatchObject({
            _tag: "Left",
            left: { code: "Unauthorized" },
          });
          const read = yield* Effect.either(getPost.run({ id: created.id }));
          const list = yield* Effect.either(listPosts.run({ limit: 10 }));
          const update = yield* Effect.either(
            updateDraft.run({ id: created.id, body: "Managed edit" }),
          );
          expect(read).toMatchObject({ _tag: mode === "no-permission" ? "Left" : "Right" });
          expect(list).toMatchObject({ _tag: mode === "no-permission" ? "Left" : "Right" });
          expect(update).toMatchObject({ _tag: mode === "manage-only" ? "Right" : "Left" });
          expect(rows.get(created.id)?.fields["body"]).toBe(
            mode === "manage-only" ? "Managed edit" : input.body,
          );
          expect(rows.size).toBe(1);
        }).pipe(Effect.provide(services)),
      );
    },
  );
  it("MCP advertises exactly four tools and round trips a draft", async () => {
    const { persistence } = memoryPersistence();
    const server = buildContentMcpServer(
      Layer.merge(contentStoreLayer(persistence), Layer.succeed(ContentActor, actor)),
    );
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_posts",
        "get_post",
        "create_draft",
        "update_draft",
      ]);
      const created = await client.callTool({ name: "create_draft", arguments: input });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        type: "post",
        createdById: "author",
        fields: { state: "draft" },
      });
      expect((await client.callTool({ name: "publish", arguments: {} })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
