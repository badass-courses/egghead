import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "@auth/core/adapters";

/**
 * The slice of the database the account-linking contract inspects. One
 * in-memory implementation runs in `pnpm check`; the MySQL one wraps the
 * shipped `createAuthJsAdapter(getCourseBuilderAdapter())`.
 */
export type AuthStore = {
  name: "memory" | "mysql";
  adapter: Adapter;
  reset: () => Promise<void>;
  seedUser: (email: string) => Promise<string>;
  seedAccount: (userId: string, provider: string, providerAccountId: string) => Promise<void>;
  accountOwner: (provider: string, providerAccountId: string) => Promise<string | null>;
  accountCount: () => Promise<number>;
  userCount: () => Promise<number>;
  userEmail: (userId: string) => Promise<string | null>;
  close: () => Promise<void>;
};

/**
 * In-memory Auth.js adapter. It mirrors the MySQL behaviour the contract
 * relies on: case-insensitive email lookup (the `utf8mb4_0900_ai_ci` column)
 * and the `(provider, providerAccountId)` primary key on Account.
 */
export function createMemoryAuthStore(): AuthStore {
  const users = new Map<string, AdapterUser>();
  const accounts: AdapterAccount[] = [];
  const sessions = new Map<string, AdapterSession>();
  const verificationTokens: VerificationToken[] = [];
  let nextUserId = 1;

  function insertUser(user: Omit<AdapterUser, "id">) {
    const created: AdapterUser = { ...user, id: `user_${nextUserId}` };
    nextUserId += 1;
    users.set(created.id, created);
    return created;
  }

  function insertAccount(account: AdapterAccount) {
    const duplicate = accounts.some(
      (existing) =>
        existing.provider === account.provider &&
        existing.providerAccountId === account.providerAccountId,
    );
    if (duplicate) throw new Error("Duplicate entry for Account PRIMARY key");
    accounts.push(account);
  }

  const adapter: Adapter = {
    async createUser(user) {
      return insertUser({
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name ?? null,
      });
    },
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async getUserByEmail(email) {
      const normalized = email.toLowerCase();
      return [...users.values()].find((user) => user.email.toLowerCase() === normalized) ?? null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const account = accounts.find(
        (candidate) =>
          candidate.provider === provider && candidate.providerAccountId === providerAccountId,
      );
      return account ? (users.get(account.userId) ?? null) : null;
    },
    async updateUser(user) {
      const existing = users.get(user.id);
      if (!existing) throw new Error("Unknown user");
      const updated = { ...existing, ...user };
      users.set(updated.id, updated);
      return updated;
    },
    async linkAccount(account) {
      insertAccount(account);
      return account;
    },
    async createSession(session) {
      sessions.set(session.sessionToken, session);
      return session;
    },
    async getSessionAndUser(sessionToken) {
      const session = sessions.get(sessionToken);
      const user = session ? users.get(session.userId) : undefined;
      return session && user ? { session, user } : null;
    },
    async updateSession(session) {
      const existing = sessions.get(session.sessionToken);
      if (!existing) return null;
      const updated = { ...existing, ...session };
      sessions.set(updated.sessionToken, updated);
      return updated;
    },
    async deleteSession(sessionToken) {
      sessions.delete(sessionToken);
    },
    async createVerificationToken(token) {
      verificationTokens.push(token);
      return token;
    },
    async useVerificationToken({ identifier, token }) {
      const index = verificationTokens.findIndex(
        (candidate) => candidate.identifier === identifier && candidate.token === token,
      );
      if (index === -1) return null;
      const [used] = verificationTokens.splice(index, 1);
      return used ?? null;
    },
  };

  return {
    name: "memory",
    adapter,
    reset: async () => {
      users.clear();
      accounts.length = 0;
      sessions.clear();
      verificationTokens.length = 0;
    },
    seedUser: async (email) => insertUser({ email, emailVerified: new Date(), name: null }).id,
    seedAccount: async (userId, provider, providerAccountId) =>
      insertAccount({ userId, type: "oauth", provider, providerAccountId }),
    accountOwner: async (provider, providerAccountId) =>
      accounts.find(
        (account) =>
          account.provider === provider && account.providerAccountId === providerAccountId,
      )?.userId ?? null,
    accountCount: async () => accounts.length,
    userCount: async () => users.size,
    userEmail: async (userId) => users.get(userId)?.email ?? null,
    close: async () => {},
  };
}
