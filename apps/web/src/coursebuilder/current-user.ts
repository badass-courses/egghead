import { userSchema } from "@coursebuilder/core/schemas";

export async function getCurrentUser() {
  const appOwnedUser = null;

  return appOwnedUser ? userSchema.parse(appOwnedUser) : null;
}
