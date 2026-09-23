import assert from "node:assert/strict";
import { EditPostSchema } from "../apps/builder-egghead/src/lib/posts/schemas";

const post = {
  id: "synthetic-post",
  type: "post",
  createdById: "synthetic-author",
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  organizationId: null,
  createdByOrganizationMembershipId: null,
  fields: { title: "A valid post title", slug: "a-valid-post-title" },
};
assert.equal(EditPostSchema.safeParse(post).success, true);
assert.equal(
  EditPostSchema.safeParse({ ...post, fields: { ...post.fields, title: "a" } }).success,
  false,
);
assert.equal(
  EditPostSchema.safeParse({ ...post, fields: { ...post.fields, title: "a".repeat(91) } }).success,
  false,
);
assert.equal(
  EditPostSchema.safeParse({ ...post, fields: { title: post.fields.title } }).success,
  false,
);
console.log(
  "Post editor schema accepts complete posts and rejects missing slugs and invalid title lengths.",
);
