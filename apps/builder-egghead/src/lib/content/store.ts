import { Effect, Layer, Schema } from "effect";
import { ContentStore, type ContentAudit } from "@egghead/core/content";
import { ContentFailure, ContentPost } from "@egghead/core/contracts/content";
import { guid } from "@coursebuilder/utils/guid";
import slugify from "@sindresorhus/slugify";

export type StoredPost = {
  id: string;
  type: string;
  createdById: string;
  fields: Record<string, unknown>;
  deletedAt: Date | null;
};
/** The only driver-specific seam; compareAndSwap must guard the full snapshot atomically. */
export type ContentPersistence = {
  read: (id: string) => Promise<StoredPost | null>;
  list: (input: {
    limit: number;
    cursor?: string | undefined;
    ownerId?: string | undefined;
  }) => Promise<StoredPost[]>;
  create: (post: StoredPost) => Promise<unknown>;
  compareAndSwap: (
    current: StoredPost,
    changes: Record<string, unknown>,
    audit: ContentAudit & { at: string },
  ) => Promise<boolean>;
};

const operation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new ContentFailure({ code: "StoreUnavailable", message: "Content store unavailable" }),
  });
const decode = (post: StoredPost) => {
  // Legacy nullable optional fields are absent on the machine view, not converted to strings.
  const fields = Object.fromEntries(
    Object.entries(post.fields).filter(([, value]) => value !== null),
  );
  return Schema.decodeUnknown(ContentPost)({ ...post, fields }).pipe(
    Effect.mapError(
      () => new ContentFailure({ code: "StoreUnavailable", message: "Invalid stored post" }),
    ),
  );
};
export function contentStoreLayer(persistence: ContentPersistence) {
  const read = (id: string) => operation(() => persistence.read(id));
  return Layer.succeed(ContentStore, {
    get: (id) =>
      Effect.gen(function* () {
        const post = yield* read(id);
        return post && post.type === "post" && !post.deletedAt ? yield* decode(post) : null;
      }),
    list: (input) =>
      Effect.gen(function* () {
        const rows = yield* operation(() => persistence.list(input));
        const page = rows.slice(0, input.limit);
        const posts = yield* Effect.forEach(page, decode);
        return { posts, nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null };
      }),
    create: (input, audit) =>
      Effect.gen(function* () {
        const postGuid = guid();
        const id = `post_${postGuid}`;
        const post: StoredPost = {
          id,
          type: "post",
          createdById: audit.userId,
          deletedAt: null,
          fields: {
            ...input.fields,
            title: input.title,
            body: input.body,
            postType: input.postType,
            slug: `${slugify(input.title)}~${postGuid}`,
            state: "draft",
            visibility: "unlisted",
            access: "pro",
            contentMcpAudit: [{ ...audit, at: new Date().toISOString() }],
          },
        };
        yield* operation(() => persistence.create(post));
        return yield* decode(post);
      }),
    revise: (current, input, audit) =>
      Effect.gen(function* () {
        const snapshot = yield* read(current.id);
        if (
          !snapshot ||
          snapshot.deletedAt ||
          snapshot.type !== "post" ||
          snapshot.createdById !== current.createdById ||
          snapshot.fields["state"] !== "draft"
        )
          return yield* Effect.fail(
            new ContentFailure({ code: "Conflict", message: "Draft changed; read it again" }),
          );
        const changes = {
          ...input.fields,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        };
        const saved = yield* operation(() =>
          persistence.compareAndSwap(snapshot, changes, { ...audit, at: new Date().toISOString() }),
        );
        if (!saved)
          return yield* Effect.fail(
            new ContentFailure({ code: "Conflict", message: "Draft changed; read it again" }),
          );
        return yield* decode({ ...snapshot, fields: { ...snapshot.fields, ...changes } });
      }),
  });
}
