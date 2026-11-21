import { Context, Effect } from "effect";
import { implement } from "./capability";
import {
  ContentFailure,
  type ContentPost,
  type ContentPage,
  createDraftContract,
  getPostContract,
  listPostsContract,
  updateDraftContract,
} from "./contracts/content";

export type ContentAudit = {
  readonly userId: string;
  /** SHA-256 identity of the token row: never the bearer credential itself. */
  readonly tokenId: string;
  readonly actorLabel: string;
};
export class ContentActor extends Context.Tag("egghead/ContentActor")<
  ContentActor,
  ContentAudit & {
    readonly canCreate: boolean;
    readonly canManageAll: boolean;
    readonly canRead: (post: ContentPost) => boolean;
    readonly canManage: (post: ContentPost) => boolean;
  }
>() {}
export class ContentStore extends Context.Tag("egghead/ContentStore")<
  ContentStore,
  {
    readonly get: (id: string) => Effect.Effect<ContentPost | null, ContentFailure>;
    readonly list: (input: {
      limit: number;
      cursor?: string | undefined;
      ownerId?: string | undefined;
    }) => Effect.Effect<typeof ContentPage.Type, ContentFailure>;
    readonly create: (
      input: typeof createDraftContract.input.Type,
      audit: ContentAudit,
    ) => Effect.Effect<ContentPost, ContentFailure>;
    readonly revise: (
      current: ContentPost,
      input: typeof updateDraftContract.input.Type,
      audit: ContentAudit,
    ) => Effect.Effect<ContentPost, ContentFailure>;
  }
>() {}
const auditOf = (actor: ContentAudit): ContentAudit => ({
  userId: actor.userId,
  tokenId: actor.tokenId,
  actorLabel: actor.actorLabel,
});
const missing = () => new ContentFailure({ code: "NotFound", message: "Post not found" });
export const listPosts = implement(listPostsContract, (input) =>
  Effect.gen(function* () {
    const actor = yield* ContentActor;
    const page = yield* (yield* ContentStore).list({
      ...input,
      ownerId: actor.canManageAll ? undefined : actor.userId,
    });
    return { ...page, posts: page.posts.filter(actor.canRead) };
  }),
);
export const getPost = implement(getPostContract, ({ id }) =>
  Effect.gen(function* () {
    const actor = yield* ContentActor;
    const post = yield* (yield* ContentStore).get(id);
    if (!post || !actor.canRead(post)) return yield* Effect.fail(missing());
    return post;
  }),
);
export const createDraft = implement(createDraftContract, (input) =>
  Effect.gen(function* () {
    const actor = yield* ContentActor;
    if (!actor.canCreate)
      return yield* Effect.fail(
        new ContentFailure({ code: "Unauthorized", message: "Cannot create Content" }),
      );
    return yield* (yield* ContentStore).create(input, auditOf(actor));
  }),
);
export const updateDraft = implement(updateDraftContract, (input) =>
  Effect.gen(function* () {
    const actor = yield* ContentActor;
    const store = yield* ContentStore;
    const current = yield* store.get(input.id);
    if (!current || !actor.canManage(current)) return yield* Effect.fail(missing());
    if (current.fields.state !== "draft")
      return yield* Effect.fail(
        new ContentFailure({ code: "Conflict", message: "Only drafts can be edited" }),
      );
    return yield* store.revise(current, input, auditOf(actor));
  }),
);
export const contentCapabilities = [listPosts, getPost, createDraft, updateDraft] as const;
export type ContentCapability = (typeof contentCapabilities)[number];
