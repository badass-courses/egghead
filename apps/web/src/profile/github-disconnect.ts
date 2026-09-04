import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { assertAccountWritesAllowed, createLocalMysqlConnection } from "../db/local-docker";
import { requireProfileOwner } from "./contracts";

const GITHUB_PROVIDER = "github";
const ENABLED_SIGN_IN_PROVIDERS = new Set([GITHUB_PROVIDER]);

type AuthAccountReference = {
  userId: string;
  provider: string;
  providerAccountId: string;
};

type AuthAccountRow = RowDataPacket & AuthAccountReference;

export type GithubConnectionState = {
  connected: boolean;
  disconnectAllowed: boolean;
  blockedReason: "last-sign-in-method" | null;
};

export type GithubDisconnectResult =
  | { status: "disconnected" }
  | { status: "last-sign-in-method" }
  | { status: "missing" }
  | { status: "conflict" };

export type GithubDisconnectPlan =
  | { status: "last-sign-in-method" }
  | { status: "missing" }
  | {
      status: "ready";
      account: AuthAccountReference;
    };

export const OWNER_AUTH_ACCOUNTS_FOR_UPDATE_SQL = `
  SELECT account.userId, account.provider, account.providerAccountId
  FROM egghead_Account account
  WHERE account.userId = ?
  ORDER BY account.provider ASC, account.providerAccountId ASC
  FOR UPDATE
`;

export const OWNER_SCOPED_GITHUB_DISCONNECT_SQL = `
  DELETE FROM egghead_Account
  WHERE userId = ?
    AND provider = ?
    AND providerAccountId = ?
  LIMIT 1
`;

function isEnabledSignInAccount(account: { provider: string }) {
  return ENABLED_SIGN_IN_PROVIDERS.has(account.provider.toLowerCase());
}

function firstGithubAccountIndex(accounts: readonly { provider: string }[]) {
  return accounts.findIndex((account) => account.provider === GITHUB_PROVIDER);
}

export function summarizeGithubConnection(
  accounts: readonly { provider: string }[],
  emailSignInAvailable: boolean,
): GithubConnectionState {
  const githubIndex = firstGithubAccountIndex(accounts);
  if (githubIndex === -1) {
    return {
      connected: false,
      disconnectAllowed: false,
      blockedReason: null,
    };
  }

  const hasRemainingSignInMethod =
    emailSignInAvailable ||
    accounts.some((account, index) => index !== githubIndex && isEnabledSignInAccount(account));

  return {
    connected: true,
    disconnectAllowed: hasRemainingSignInMethod,
    blockedReason: hasRemainingSignInMethod ? null : "last-sign-in-method",
  };
}

export function planOwnerGithubDisconnect(input: {
  actorUserId: string | null;
  profileUserId: string;
  accounts: readonly AuthAccountReference[];
  emailSignInAvailable: boolean;
}): GithubDisconnectPlan {
  const userId = requireProfileOwner(input.actorUserId, input.profileUserId);
  const ownedAccounts = input.accounts
    .filter((account) => account.userId === userId)
    .toSorted((left, right) => {
      const providerOrder = left.provider.localeCompare(right.provider);
      return providerOrder || left.providerAccountId.localeCompare(right.providerAccountId);
    });
  const githubIndex = firstGithubAccountIndex(ownedAccounts);

  if (githubIndex === -1) return { status: "missing" };

  const account = ownedAccounts[githubIndex];
  if (!account) return { status: "missing" };

  const hasRemainingSignInMethod =
    input.emailSignInAvailable ||
    ownedAccounts.some(
      (candidate, index) => index !== githubIndex && isEnabledSignInAccount(candidate),
    );
  if (!hasRemainingSignInMethod) return { status: "last-sign-in-method" };

  return {
    status: "ready",
    account,
  };
}

export function githubDisconnectResultForAffectedRows(affectedRows: number) {
  return affectedRows === 1
    ? ({ status: "disconnected" } as const)
    : ({ status: "conflict" } as const);
}

export async function disconnectPrivateGithubAccount(input: {
  actorUserId: string | null;
  profileUserId: string;
  emailSignInAvailable: boolean;
}): Promise<GithubDisconnectResult> {
  const userId = requireProfileOwner(input.actorUserId, input.profileUserId);
  assertAccountWritesAllowed();
  const connection = await createLocalMysqlConnection();

  try {
    await connection.beginTransaction();
    const [accountRows] = await connection.execute<AuthAccountRow[]>(
      OWNER_AUTH_ACCOUNTS_FOR_UPDATE_SQL,
      [userId],
    );
    const plan = planOwnerGithubDisconnect({
      actorUserId: userId,
      profileUserId: userId,
      accounts: accountRows,
      emailSignInAvailable: input.emailSignInAvailable,
    });

    if (plan.status !== "ready") {
      await connection.rollback();
      return plan;
    }

    const [result] = await connection.execute<ResultSetHeader>(OWNER_SCOPED_GITHUB_DISCONNECT_SQL, [
      userId,
      GITHUB_PROVIDER,
      plan.account.providerAccountId,
    ]);

    const mutationResult = githubDisconnectResultForAffectedRows(result.affectedRows);
    if (mutationResult.status === "conflict") {
      await connection.rollback();
      return mutationResult;
    }

    await connection.commit();
    return mutationResult;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}
