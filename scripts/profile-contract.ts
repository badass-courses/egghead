import {
  currentLearningStreakDays,
  ownerScopedNameUpdate,
  parsePublicProfileId,
  projectPublicLearnerProfile,
  requireProfileOwner,
  safePublicAvatarUrl,
} from "../apps/web/src/profile/contracts";
import {
  escapeMysqlLikePattern,
  PRIVATE_PROFILE_ACCOUNTS_SQL,
  OWNER_SCOPED_NAME_UPDATE_SQL,
  PUBLISHED_COMPLETION_STATS_SQL,
  PUBLISHED_LEARNING_DAYS_SQL,
  PUBLIC_PROFILE_USER_SQL,
  ROUTABLE_PROFILE_COMPLETION_SQL,
} from "../apps/web/src/profile/data";
import {
  githubDisconnectResultForAffectedRows,
  OWNER_AUTH_ACCOUNTS_FOR_UPDATE_SQL,
  OWNER_SCOPED_GITHUB_DISCONNECT_SQL,
  planOwnerGithubDisconnect,
  summarizeGithubConnection,
} from "../apps/web/src/profile/github-disconnect";

type ContractCheck = {
  name: string;
  pass: true;
};

function pass(name: string): ContractCheck {
  return { name, pass: true };
}

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return pass(name);
}

function assertDeepEqual(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  return pass(name);
}

function assertIncludes(name: string, actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`${name}: expected string to include ${expected}`);
  }

  return pass(name);
}

function assertNotIncludes(name: string, actual: string, blocked: string) {
  if (actual.includes(blocked)) {
    throw new Error(`${name}: did not expect string to include ${blocked}`);
  }

  return pass(name);
}

function expectThrow(name: string, run: () => unknown) {
  try {
    run();
  } catch {
    return pass(name);
  }

  throw new Error(`${name}: expected function to throw`);
}

const validPublicId = "learner_1234567890";
const uuidPublicId = "a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6";
const broadUserShape = {
  id: validPublicId,
  name: "  Ada Learner  ",
  image: "https://res.cloudinary.com/demo/image/upload/avatar.png",
  createdAt: new Date("2025-02-10T12:00:00.000Z"),
  email: "redacted-private-contact",
  role: "admin",
  fields: { privateNote: "never publish" },
  accounts: [{ provider: "github" }],
  purchases: [{ id: "private-purchase" }],
};
const completions = [
  {
    resourceId: "lesson-2",
    family: "lesson" as const,
    title: "Second lesson",
    href: "/modern-react/second-lesson",
    course: {
      title: "Modern React",
      href: "/modern-react",
    },
    completedAt: new Date("2026-07-10T12:00:00.000Z"),
  },
  {
    resourceId: "course-1",
    family: "course" as const,
    title: "Modern React",
    href: "/modern-react",
    course: null,
    completedAt: new Date("2026-06-02T12:00:00.000Z"),
  },
];

const ownerUpdate = ownerScopedNameUpdate({
  actorUserId: validPublicId,
  profileUserId: validPublicId,
  name: "  Ada Lovelace  ",
});
const publicProjection = projectPublicLearnerProfile(broadUserShape, completions, {
  lessonCount: 8,
  courseCount: 2,
  activeMonthCount: 7,
});
const emptyProjection = projectPublicLearnerProfile(
  {
    id: uuidPublicId,
    name: null,
    image: null,
    createdAt: null,
  },
  [],
);
const serializedProjection = JSON.stringify(publicProjection).toLowerCase();
const publicQuery = PUBLIC_PROFILE_USER_SQL.toLowerCase();
const updateQuery = OWNER_SCOPED_NAME_UPDATE_SQL.toLowerCase();
const privateAccountsQuery = PRIVATE_PROFILE_ACCOUNTS_SQL.toLowerCase();
const routableCompletionQuery = ROUTABLE_PROFILE_COMPLETION_SQL.toLowerCase();
const completionStatsQuery = PUBLISHED_COMPLETION_STATS_SQL.toLowerCase();
const learningDaysQuery = PUBLISHED_LEARNING_DAYS_SQL.toLowerCase();
const streakToday = new Date("2026-08-07T12:00:00.000Z");
const disconnectReadQuery = OWNER_AUTH_ACCOUNTS_FOR_UPDATE_SQL.toLowerCase();
const disconnectQuery = OWNER_SCOPED_GITHUB_DISCONNECT_SQL.toLowerCase();
const ownerWithTwoGithubAccounts = [
  {
    userId: validPublicId,
    provider: "github",
    providerAccountId: "github-account-z",
  },
  {
    userId: validPublicId,
    provider: "github",
    providerAccountId: "github-account-a",
  },
];
const readyDisconnect = planOwnerGithubDisconnect({
  actorUserId: validPublicId,
  profileUserId: validPublicId,
  accounts: ownerWithTwoGithubAccounts,
  emailSignInAvailable: false,
});

const checks = [
  expectThrow("private profile rejects an anonymous actor", () =>
    requireProfileOwner(null, validPublicId),
  ),
  expectThrow("private profile rejects a different signed-in user", () =>
    requireProfileOwner("different_user_123", validPublicId),
  ),
  assertEqual(
    "private profile accepts its exact owner",
    requireProfileOwner(validPublicId, validPublicId),
    validPublicId,
  ),
  assertDeepEqual("name mutation is trimmed and scoped to the owner ID", ownerUpdate, {
    userId: validPublicId,
    name: "Ada Lovelace",
  }),
  expectThrow("name mutation rejects a cross-user target", () =>
    ownerScopedNameUpdate({
      actorUserId: validPublicId,
      profileUserId: "different_user_123",
      name: "Ada",
    }),
  ),
  assertEqual(
    "full canonical public ID is valid",
    parsePublicProfileId(validPublicId),
    validPublicId,
  ),
  assertEqual("UUID public ID is valid", parsePublicProfileId(uuidPublicId), uuidPublicId),
  assertEqual(
    "arbitrary eight-character prefix is rejected",
    parsePublicProfileId("a1b2c3d4"),
    null,
  ),
  assertEqual("path-shaped public ID is rejected", parsePublicProfileId("learner/123456789"), null),
  assertEqual(
    "SQL wildcard public ID is rejected",
    parsePublicProfileId("learner%123456789"),
    null,
  ),
  assertEqual(
    "profile search preserves ordinary text",
    escapeMysqlLikePattern("react course"),
    "react course",
  ),
  assertEqual(
    "profile search escapes LIKE wildcards",
    escapeMysqlLikePattern("100%_complete"),
    "100\\%\\_complete",
  ),
  assertEqual(
    "profile search escapes the escape character first",
    escapeMysqlLikePattern("path\\name"),
    "path\\\\name",
  ),
  assertIncludes("public lookup uses an exact ID predicate", publicQuery, "where user.id = ?"),
  assertNotIncludes("public lookup does not use a prefix query", publicQuery, "like"),
  assertNotIncludes("public user lookup does not select email", publicQuery, "email"),
  assertNotIncludes("public user lookup does not select flexible fields", publicQuery, "fields"),
  assertIncludes("public lookup selects the explicit image field", publicQuery, "user.image"),
  assertIncludes("profile update scopes the row in SQL", updateQuery, "where id = ?"),
  assertIncludes(
    "completion history filters missing and non-string slugs before limiting rows",
    routableCompletionQuery,
    "json_type(json_extract(resource.fields, '$.slug')) = 'string'",
  ),
  assertIncludes(
    "completion history rejects blank and null-like slugs before limiting rows",
    routableCompletionQuery,
    "not in ('', 'null')",
  ),
  assertIncludes(
    "completion history filters unsupported content families before limiting rows",
    routableCompletionQuery,
    "end as binary",
  ),
  assertIncludes(
    "completion stats track lessons separately",
    completionStatsQuery,
    "as lessoncount",
  ),
  assertIncludes(
    "completion stats track courses separately",
    completionStatsQuery,
    "as coursecount",
  ),
  assertIncludes(
    "learning streak days are distinct calendar days",
    learningDaysQuery,
    "select distinct date_format",
  ),
  assertIncludes("learning streak includes lessons", learningDaysQuery, "cast('lesson' as binary)"),
  assertIncludes("learning streak includes courses", learningDaysQuery, "cast('course' as binary)"),
  assertEqual(
    "empty learning activity has no streak",
    currentLearningStreakDays([], streakToday),
    0,
  ),
  assertEqual(
    "one completion day starts a streak",
    currentLearningStreakDays(["2026-08-07"], streakToday),
    1,
  ),
  assertEqual(
    "multiple completions on one day increment the streak once",
    currentLearningStreakDays(["2026-08-07", "2026-08-07"], streakToday),
    1,
  ),
  assertEqual(
    "consecutive completion days extend the streak",
    currentLearningStreakDays(["2026-08-07", "2026-08-06", "2026-08-05"], streakToday),
    3,
  ),
  assertEqual(
    "a streak completed yesterday remains current",
    currentLearningStreakDays(["2026-08-06", "2026-08-05"], streakToday),
    2,
  ),
  assertEqual(
    "a break before yesterday resets the streak",
    currentLearningStreakDays(["2026-08-05", "2026-08-04"], streakToday),
    0,
  ),
  assertEqual(
    "a break within the chain stops the streak count",
    currentLearningStreakDays(["2026-08-07", "2026-08-05"], streakToday),
    1,
  ),
  assertEqual(
    "malformed completion days are ignored",
    currentLearningStreakDays(["not-a-date", "2026-08-07"], streakToday),
    1,
  ),
  assertEqual(
    "invalid calendar days are ignored",
    currentLearningStreakDays(["2026-02-30", "2026-08-07"], streakToday),
    1,
  ),
  assertEqual(
    "future completion days do not extend the streak",
    currentLearningStreakDays(["2026-08-09", "2026-08-08", "2026-08-07"], streakToday),
    1,
  ),
  expectThrow("GitHub disconnect rejects an anonymous actor", () =>
    planOwnerGithubDisconnect({
      actorUserId: null,
      profileUserId: validPublicId,
      accounts: ownerWithTwoGithubAccounts,
      emailSignInAvailable: false,
    }),
  ),
  expectThrow("GitHub disconnect rejects a cross-user target", () =>
    planOwnerGithubDisconnect({
      actorUserId: validPublicId,
      profileUserId: "different_user_123",
      accounts: ownerWithTwoGithubAccounts,
      emailSignInAvailable: false,
    }),
  ),
  assertDeepEqual(
    "GitHub disconnect reports a missing owner account",
    planOwnerGithubDisconnect({
      actorUserId: validPublicId,
      profileUserId: validPublicId,
      accounts: [
        {
          userId: validPublicId,
          provider: "google",
          providerAccountId: "unsupported-google-account",
        },
      ],
      emailSignInAvailable: false,
    }),
    { status: "missing" },
  ),
  assertDeepEqual(
    "GitHub disconnect protects the last available sign-in method",
    planOwnerGithubDisconnect({
      actorUserId: validPublicId,
      profileUserId: validPublicId,
      accounts: [
        {
          userId: validPublicId,
          provider: "github",
          providerAccountId: "only-github-account",
        },
        {
          userId: validPublicId,
          provider: "google",
          providerAccountId: "not-enabled-in-egghead",
        },
      ],
      emailSignInAvailable: false,
    }),
    { status: "last-sign-in-method" },
  ),
  assertDeepEqual(
    "GitHub disconnect is enabled when email sign-in remains available",
    planOwnerGithubDisconnect({
      actorUserId: validPublicId,
      profileUserId: validPublicId,
      accounts: [
        {
          userId: validPublicId,
          provider: "github",
          providerAccountId: "only-github-account",
        },
      ],
      emailSignInAvailable: true,
    }),
    {
      status: "ready",
      account: {
        userId: validPublicId,
        provider: "github",
        providerAccountId: "only-github-account",
      },
    },
  ),
  assertDeepEqual(
    "GitHub disconnect chooses one exact owner account deterministically",
    readyDisconnect,
    {
      status: "ready",
      account: {
        userId: validPublicId,
        provider: "github",
        providerAccountId: "github-account-a",
      },
    },
  ),
  assertDeepEqual(
    "GitHub disconnect never chooses another user's provider account",
    planOwnerGithubDisconnect({
      actorUserId: validPublicId,
      profileUserId: validPublicId,
      accounts: [
        {
          userId: "different_user_123",
          provider: "github",
          providerAccountId: "foreign-github-account",
        },
        ...ownerWithTwoGithubAccounts,
      ],
      emailSignInAvailable: false,
    }),
    readyDisconnect,
  ),
  assertDeepEqual(
    "a one-row owner deletion is a successful disconnect",
    githubDisconnectResultForAffectedRows(1),
    { status: "disconnected" },
  ),
  assertDeepEqual(
    "a missing exact row is reported as a mutation conflict",
    githubDisconnectResultForAffectedRows(0),
    { status: "conflict" },
  ),
  assertDeepEqual(
    "connected account state allows GitHub disconnect when email sign-in is available",
    summarizeGithubConnection([{ provider: "github" }], true),
    {
      connected: true,
      disconnectAllowed: true,
      blockedReason: null,
    },
  ),
  assertDeepEqual(
    "connected account state protects GitHub when email sign-in is unavailable",
    summarizeGithubConnection([{ provider: "github" }], false),
    {
      connected: true,
      disconnectAllowed: false,
      blockedReason: "last-sign-in-method",
    },
  ),
  assertDeepEqual(
    "connected account state allows removing one of two GitHub sign-ins",
    summarizeGithubConnection([{ provider: "github" }, { provider: "github" }], false),
    {
      connected: true,
      disconnectAllowed: true,
      blockedReason: null,
    },
  ),
  assertDeepEqual(
    "connected account state represents a missing GitHub account",
    summarizeGithubConnection([], true),
    {
      connected: false,
      disconnectAllowed: false,
      blockedReason: null,
    },
  ),
  assertIncludes(
    "disconnect account read is scoped to the owner",
    disconnectReadQuery,
    "where account.userid = ?",
  ),
  assertIncludes(
    "disconnect account read locks the decision rows",
    disconnectReadQuery,
    "for update",
  ),
  assertIncludes("disconnect delete is scoped to the owner", disconnectQuery, "where userid = ?"),
  assertIncludes(
    "disconnect delete is scoped to the exact provider",
    disconnectQuery,
    "and provider = ?",
  ),
  assertIncludes(
    "disconnect delete is scoped to the exact provider account",
    disconnectQuery,
    "and provideraccountid = ?",
  ),
  assertNotIncludes(
    "private connected-account projection omits provider account IDs",
    privateAccountsQuery,
    "provideraccountid",
  ),
  assertDeepEqual(
    "public projection has only the named top-level contract",
    Object.keys(publicProjection),
    ["publicId", "displayName", "avatarUrl", "memberSince", "learning"],
  ),
  assertNotIncludes(
    "public projection omits email",
    serializedProjection,
    "redacted-private-contact",
  ),
  assertNotIncludes("public projection omits roles", serializedProjection, "admin"),
  assertNotIncludes("public projection omits provider data", serializedProjection, "github"),
  assertNotIncludes(
    "public projection omits purchase data",
    serializedProjection,
    "private-purchase",
  ),
  assertNotIncludes(
    "public projection omits flexible user fields",
    serializedProjection,
    "privatenote",
  ),
  assertEqual("public projection trims display name", publicProjection.displayName, "Ada Learner"),
  assertEqual(
    "public projection includes an allowlisted HTTPS avatar",
    publicProjection.avatarUrl,
    "https://res.cloudinary.com/demo/image/upload/avatar.png",
  ),
  assertEqual(
    "public avatar projection normalizes a protocol-relative allowlisted URL",
    safePublicAvatarUrl("//gravatar.com/avatar/public-example"),
    "https://gravatar.com/avatar/public-example",
  ),
  assertEqual(
    "public avatar projection rejects an insecure URL",
    safePublicAvatarUrl("http://avatars.githubusercontent.com/u/12345"),
    null,
  ),
  assertEqual(
    "public avatar projection rejects a local URL",
    safePublicAvatarUrl("https://localhost/avatar.png"),
    null,
  ),
  assertEqual(
    "public avatar projection rejects an unapproved host",
    safePublicAvatarUrl("https://images.example.test/avatar.png"),
    null,
  ),
  assertEqual(
    "public lesson count can exceed displayed history",
    publicProjection.learning.lessonCount,
    8,
  ),
  assertEqual(
    "public course completions are counted separately",
    publicProjection.learning.courseCount,
    2,
  ),
  assertDeepEqual(
    "public lesson history includes its course context",
    publicProjection.learning.history[0]?.completions[0]?.course,
    {
      title: "Modern React",
      href: "/modern-react",
    },
  ),
  assertEqual(
    "active month count can exceed the months in truncated public history",
    publicProjection.learning.activeMonthCount,
    7,
  ),
  assertDeepEqual(
    "completion history is grouped newest month first",
    publicProjection.learning.history.map((month) => month.key),
    ["2026-07", "2026-06"],
  ),
  assertEqual(
    "empty profile uses a privacy-safe fallback name",
    emptyProjection.displayName,
    "Egghead learner",
  ),
  assertEqual(
    "empty profile renders no history groups",
    emptyProjection.learning.history.length,
    0,
  ),
  assertEqual("empty profile has no lessons", emptyProjection.learning.lessonCount, 0),
  assertEqual("empty profile has no completed courses", emptyProjection.learning.courseCount, 0),
  assertEqual("empty profile has no active months", emptyProjection.learning.activeMonthCount, 0),
];

console.log(
  JSON.stringify({
    ok: true,
    checks,
    contracts: {
      privateOwnerOnly: true,
      mutationOwnerScoped: true,
      githubDisconnectOwnerScoped: true,
      githubDisconnectExactProviderAccount: true,
      githubDisconnectProtectsLastSignInMethod: true,
      publicExactIdentifier: true,
      publicProjectionAllowlisted: true,
      emptyAndPopulatedLearningStates: true,
    },
  }),
);
