import type { Adapter, AdapterAccount } from "@auth/core/adapters";
import type { AuthStoragePort } from "@coursebuilder/core/auth";
import type { IdentityPort } from "@coursebuilder/core/ports/identity";

function isLowercase(value: string): value is Lowercase<string> {
  return value === value.toLowerCase();
}

/** Keep Auth.js account return conventions at the app boundary in CourseBuilder v3. */
export function createAuthJsAdapter(
  storage: AuthStoragePort &
    Pick<
      IdentityPort,
      | "createUser"
      | "getUser"
      | "getUserByEmail"
      | "getUserByAccount"
      | "updateUser"
      | "linkAccount"
      | "unlinkAccount"
      | "createVerificationToken"
    >,
): Adapter {
  return {
    ...storage,
    async getAccount(providerAccountId, provider) {
      if (!storage.getAccount) throw new Error("Account lookup is unavailable");
      const account = await storage.getAccount(providerAccountId, provider);
      if (!account) return null;
      const tokenType = account.token_type?.toLowerCase();
      if (tokenType !== undefined && !isLowercase(tokenType)) throw new Error("Invalid token type");
      return {
        userId: account.userId,
        type: account.type,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        ...(account.access_token != null ? { access_token: account.access_token } : {}),
        ...(account.refresh_token != null ? { refresh_token: account.refresh_token } : {}),
        ...(account.expires_at != null ? { expires_at: account.expires_at } : {}),
        ...(tokenType != null ? { token_type: tokenType } : {}),
        ...(account.scope != null ? { scope: account.scope } : {}),
        ...(account.id_token != null ? { id_token: account.id_token } : {}),
        ...(account.session_state != null ? { session_state: account.session_state } : {}),
      } satisfies AdapterAccount;
    },
    async deleteSession(token) {
      if (!storage.deleteSession) throw new Error("Session deletion is unavailable");
      await storage.deleteSession(token);
    },
    async linkAccount(account) {
      if (!storage.linkAccount) throw new Error("Account linking is unavailable");
      await storage.linkAccount({
        ...account,
        session_state:
          typeof account["session_state"] === "string" ? account["session_state"] : null,
      });
    },
    async unlinkAccount(account) {
      if (!storage.unlinkAccount) throw new Error("Account unlinking is unavailable");
      await storage.unlinkAccount(account);
    },
  };
}
