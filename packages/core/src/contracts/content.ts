import { Schema } from "effect";
import { defineContract } from "../capability";

const text = (min: number, max: number) =>
  Schema.String.pipe(Schema.minLength(min), Schema.maxLength(max));
const id = text(1, 200);
const optionalText = (max: number) => Schema.optionalWith(text(0, max), { exact: true });

export class ContentFailure extends Schema.TaggedError<ContentFailure>()("ContentFailure", {
  code: Schema.Literal("NotFound", "Unauthorized", "Conflict", "StoreUnavailable"),
  message: Schema.String,
}) {}

/** Deliberately excludes state, visibility, access, ownership, tags and integration IDs. */
export const DraftFields = Schema.Struct({
  description: optionalText(10000),
  summary: optionalText(10000),
  image: optionalText(2000),
  ogImage: optionalText(2000),
  github: optionalText(2000),
  gitpod: optionalText(2000),
});
export const ContentPost = Schema.Struct({
  id,
  type: Schema.Literal("post"),
  createdById: id,
  fields: Schema.Struct({
    title: Schema.String,
    body: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
    slug: Schema.String,
    state: Schema.String,
    postType: Schema.String,
    ...DraftFields.fields,
  }),
});
export type ContentPost = typeof ContentPost.Type;
export const ContentPage = Schema.Struct({
  posts: Schema.Array(ContentPost),
  nextCursor: Schema.NullOr(Schema.String),
});
const common = { failure: ContentFailure, needsApproval: false };
const read = { readOnly: true, idempotent: true, destructive: false, openWorld: false };
const write = { ...read, readOnly: false, idempotent: false };
export const listPostsContract = defineContract("list_posts", {
  ...common,
  description: "List accessible posts in bounded ID order.",
  input: Schema.Struct({
    limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
    cursor: Schema.optional(id),
  }),
  output: ContentPage,
  annotations: read,
});
export const getPostContract = defineContract("get_post", {
  ...common,
  description: "Read a post by ID.",
  input: Schema.Struct({ id }),
  output: ContentPost,
  annotations: read,
});
export const createDraftContract = defineContract("create_draft", {
  ...common,
  description: "Create a native CourseBuilder draft. Does not publish or write to Rails.",
  input: Schema.Struct({
    title: text(2, 90),
    body: text(0, 200000),
    postType: Schema.Literal("lesson", "article", "podcast", "course"),
    fields: DraftFields,
  }),
  output: ContentPost,
  annotations: write,
});
export const updateDraftContract = defineContract("update_draft", {
  ...common,
  description: "Edit a draft's title, body and allowed fields. Published posts cannot be edited.",
  input: Schema.Struct({
    id,
    title: Schema.optionalWith(text(2, 90), { exact: true }),
    body: optionalText(200000),
    fields: Schema.optionalWith(DraftFields, { exact: true }),
  }),
  output: ContentPost,
  annotations: write,
});
