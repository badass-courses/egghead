import { afterEach, expect, it, vi } from "vitest";
import type { ExecutedQuery } from "@planetscale/database";
import { Effect } from "effect";
import { ContentStore } from "@egghead/core/content";
import type { ContentPost } from "@egghead/core/contracts/content";

const { findFirst, update, set, where } = vi.hoisted(() => {
  const readMock = vi.fn();
  const whereMock = vi.fn();
  const setMock = vi.fn(() => ({ where: whereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return { findFirst: readMock, where: whereMock, set: setMock, update: updateMock };
});
vi.mock("@/db", () => ({
  db: { query: { contentResource: { findFirst } }, update },
  courseBuilderAdapter: { createContentResource: vi.fn() },
}));
import { courseBuilderContentStore } from "../../src/lib/content/coursebuilder-store";

afterEach(() => vi.clearAllMocks());
it.each([0, 1])(
  "uses PlanetScale rowsAffected=%i for the actual production update path",
  async (rowsAffected) => {
    const result: ExecutedQuery<Record<string, unknown>> = {
      headers: [],
      types: {},
      rows: [],
      fields: [],
      size: 0,
      statement: "update",
      insertId: "",
      rowsAffected,
      time: 0,
    };
    where.mockResolvedValue(result);
    const current: ContentPost = {
      id: "post_test",
      type: "post",
      createdById: "author",
      fields: {
        title: "Draft",
        body: "Before",
        slug: "draft",
        state: "draft",
        postType: "article",
      },
    };
    findFirst.mockResolvedValue({ ...current, deletedAt: null });
    const edited = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ContentStore;
        return yield* store.revise(
          current,
          { id: current.id, body: "After" },
          {
            userId: "author",
            tokenId: "non-secret-hash",
            actorLabel: "test-agent",
          },
        );
      }).pipe(Effect.provide(courseBuilderContentStore()), Effect.either),
    );
    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(edited).toMatchObject(
      rowsAffected === 1
        ? { _tag: "Right", right: { fields: { body: "After" } } }
        : { _tag: "Left", left: { code: "Conflict" } },
    );
  },
);
