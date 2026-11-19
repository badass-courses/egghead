// Synthetic fixtures for access-delta tests. No real customers: every email is
// @example.test and every id is invented.
//
// "July" rows are written by hand in the exact shape the July 2026 projection
// (migrate-egghead tools/me.ts) wrote, with ids hashed independently of the code
// under test, so the tests prove July rows compare as unchanged.

import { createHash } from "node:crypto";

export const NOW_ISO = "2026-11-19T12:00:00.000Z";

function julyId(prefix: string, input: string) {
  return `${prefix}_${createHash("sha1").update(input).digest("hex").slice(0, 32)}`;
}

export const ids = {
  user: (rails: string) => julyId("eh_user", rails),
  org: (account: string) => julyId("eh_org", account),
  membership: (accountUser: string) => julyId("eh_orgmem", accountUser),
  subOrgEntitlement: (sub: string, account: string) =>
    julyId(
      "eh_entitlement",
      `rails_account_subscription:${sub}:organization:${julyId("eh_org", account)}:egghead_all_access_subscription`,
    ),
  seatEntitlement: (sub: string, accountUser: string) =>
    julyId(
      "eh_entitlement",
      `rails_account_subscription:${sub}:membership:${julyId("eh_orgmem", accountUser)}:egghead_all_access_subscription`,
    ),
  roleEntitlement: (role: string, rails: string) =>
    julyId("eh_entitlement", `rails_user_role:${role}:${rails}`),
  basicEntitlement: (rails: string) => julyId("eh_entitlement", `rails_legacy_basic_role:${rails}`),
  roleMembership: (account: string, rails: string) =>
    julyId("eh_orgmem", `role:${account}:${rails}`),
  purchaseEntitlement: (purchaseId: string) =>
    julyId("eh_entitlement", `rails_sellable_purchase:${purchaseId}`),
};

export const CB_NATIVE_LINK_USER = "cb-native-user-111";
export const CB_NATIVE_STRIPE_USER = "cb-native-user-112";
export const STRIPE_NATIVE_ENTITLEMENT = "stripe_ent_sub_fixture_112";
export const QUARANTINE_ENTITLEMENT = julyId("eh_entitlement", "rails_legacy_pro_quarantine:104");

export interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: string;
  fields: Record<string, unknown>;
}
export interface FixtureOrganization {
  id: string;
  name: string;
  fields: Record<string, unknown>;
}
export interface FixtureMembership {
  id: string;
  organizationId: string;
  userId: string;
  invitedById: string;
  role: string;
  fields: Record<string, unknown>;
}
export interface FixtureEntitlement {
  id: string;
  entitlementType: string;
  userId: string | null;
  organizationId: string | null;
  organizationMembershipId: string | null;
  sourceType: string;
  sourceId: string;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  deletedAt: string | null;
}

function julyUser(rails: string): FixtureUser {
  return {
    id: ids.user(rails),
    email: `u${rails}@example.test`,
    name: `Learner ${rails}`,
    role: "user",
    fields: {
      source: "rails_user_access_projection",
      legacyRailsUserId: rails,
      isBanned: false,
      signInCount: 3,
      hasAuthenticationToken: false,
    },
  };
}

function julyOrg(account: string): FixtureOrganization {
  return {
    id: ids.org(account),
    name: `Account ${account}`,
    fields: {
      source: "rails_account_subscription",
      legacyRailsAccountId: account,
      stripeCustomerIdPresent: true,
    },
  };
}

function julyMembership(
  account: string,
  accountUser: string,
  rails: string,
  roles: { member: boolean; owner: boolean },
): FixtureMembership {
  return {
    id: ids.membership(accountUser),
    organizationId: ids.org(account),
    userId: ids.user(rails),
    invitedById: ids.user(rails),
    role: roles.owner ? "owner" : roles.member ? "member" : "user",
    fields: {
      source: "rails_account_user",
      legacyRailsAccountUserId: accountUser,
      legacyRailsAccountId: account,
      legacyRailsUserId: rails,
      hasAccountMemberRole: roles.member,
      hasAccountOwnerRole: roles.owner,
    },
  };
}

function julySubOrg(
  sub: string,
  account: string,
  status: string,
  quantity: number,
  cpe: string,
): FixtureEntitlement {
  const orgId = ids.org(account);
  return {
    id: ids.subOrgEntitlement(sub, account),
    entitlementType: "egghead_all_access_subscription",
    userId: null,
    organizationId: orgId,
    organizationMembershipId: null,
    sourceType: "rails_account_subscription",
    sourceId: sub,
    metadata: {
      idempotencyKey: `rails_account_subscription:${sub}:organization:${orgId}:egghead_all_access_subscription`,
      source: "enabled_account_subscription",
      railsAccountSubscriptionId: sub,
      railsAccountId: account,
      status,
      quantity,
      accessReason: "enabled_account_subscription",
      accessLaw: "lenient_status_v1",
      currentPeriodEnd: cpe,
      ownerType: "organization",
    },
    expiresAt: null,
    deletedAt: null,
  };
}

function julySeat(
  sub: string,
  account: string,
  accountUser: string,
  rails: string,
  status: string,
  quantity: number,
  cpe: string,
): FixtureEntitlement {
  const membershipId = ids.membership(accountUser);
  return {
    id: ids.seatEntitlement(sub, accountUser),
    entitlementType: "egghead_all_access_subscription",
    userId: ids.user(rails),
    organizationId: ids.org(account),
    organizationMembershipId: membershipId,
    sourceType: "rails_account_subscription",
    sourceId: sub,
    metadata: {
      idempotencyKey: `rails_account_subscription:${sub}:membership:${membershipId}:egghead_all_access_subscription`,
      source: "enabled_account_subscription",
      railsAccountSubscriptionId: sub,
      railsAccountId: account,
      railsAccountUserId: accountUser,
      railsUserId: rails,
      status,
      quantity,
      accessReason: "enabled_account_subscription_membership",
      accessLaw: "lenient_status_v1",
      currentPeriodEnd: cpe,
      scopedAccountMemberRole: true,
      ownerType: "user",
    },
    expiresAt: null,
    deletedAt: null,
  };
}

function julyPurchase(
  purchaseId: string,
  rails: string,
  sellableId: string,
  expiresAt: string | null,
): FixtureEntitlement {
  return {
    id: ids.purchaseEntitlement(purchaseId),
    entitlementType: "egghead_playlist_access",
    userId: ids.user(rails),
    organizationId: null,
    organizationMembershipId: null,
    sourceType: "rails_sellable_purchase",
    sourceId: purchaseId,
    metadata: {
      idempotencyKey: `rails_sellable_purchase:${purchaseId}`,
      source: "viewable_sellable_purchase",
      railsSellablePurchaseId: purchaseId,
      railsUserId: rails,
      sellableType: "Playlist",
      sellableId,
      accessReason: "viewable_sellable_purchase",
    },
    expiresAt,
    deletedAt: null,
  };
}

const JULY_CPE = "2026-07-31T00:00:00.000Z";
const LAPSED_CPE = "2026-08-01T00:00:00.000Z";

/** CourseBuilder as the July projection left it (plus two CourseBuilder-native users). */
export function julyCourseBuilder() {
  const users: FixtureUser[] = ["101", "102", "104", "105", "106", "107", "108", "110"].map(
    julyUser,
  );
  users.push(
    {
      id: CB_NATIVE_LINK_USER,
      email: "linked@example.test",
      name: "Beta signup",
      role: "user",
      fields: {},
    },
    {
      id: CB_NATIVE_STRIPE_USER,
      email: "stripe-native@example.test",
      name: "CourseBuilder subscriber",
      role: "user",
      fields: {},
    },
  );
  const organizations = ["7001", "7002", "7004", "7010"].map(julyOrg);
  const memberships = [
    julyMembership("7001", "8001", "101", { member: true, owner: true }),
    julyMembership("7002", "8002", "102", { member: true, owner: false }),
    julyMembership("7004", "8004", "104", { member: false, owner: true }),
    julyMembership("7004", "8005", "105", { member: true, owner: false }),
    julyMembership("7004", "8007", "107", { member: true, owner: false }),
    julyMembership("7010", "8010", "110", { member: true, owner: false }),
  ];
  const entitlements: FixtureEntitlement[] = [
    julySubOrg("9001", "7001", "active", 1, JULY_CPE),
    julySeat("9001", "7001", "8001", "101", "active", 1, JULY_CPE),
    julySubOrg("9002", "7002", "active", 1, JULY_CPE),
    julySeat("9002", "7002", "8002", "102", "active", 1, JULY_CPE),
    julySubOrg("9004", "7004", "active", 5, JULY_CPE),
    julySeat("9004", "7004", "8005", "105", "active", 5, JULY_CPE),
    julySeat("9004", "7004", "8007", "107", "active", 5, JULY_CPE),
    julySubOrg("9010", "7010", "active", 1, LAPSED_CPE),
    julySeat("9010", "7010", "8010", "110", "active", 1, LAPSED_CPE),
    // A time-boxed purchase that ran out in September: Rails drops it for time.
    julyPurchase("6009", "101", "590", "2026-09-01T00:00:00.000Z"),
    {
      id: STRIPE_NATIVE_ENTITLEMENT,
      entitlementType: "egghead_all_access_subscription",
      userId: CB_NATIVE_STRIPE_USER,
      organizationId: null,
      organizationMembershipId: null,
      sourceType: "stripe_subscription",
      sourceId: "local-sub-112",
      metadata: { status: "active", stripeSubscriptionId: "sub_fixture_112" },
      expiresAt: "2026-12-31T00:00:00.000Z",
      deletedAt: null,
    },
    {
      id: QUARANTINE_ENTITLEMENT,
      entitlementType: "egghead_legacy_pro_quarantine",
      userId: ids.user("104"),
      organizationId: null,
      organizationMembershipId: null,
      sourceType: "rails_legacy_pro_role",
      sourceId: "104",
      metadata: { source: "legacy_pro_role", railsUserId: "104", defaultGrant: false },
      expiresAt: null,
      deletedAt: null,
    },
  ];
  return { users, organizations, memberships, entitlements };
}

function line(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function railsUser(rails: string, email = `u${rails}@example.test`) {
  return {
    kind: "user",
    railsUserId: rails,
    email,
    firstName: "Learner",
    lastName: rails,
    avatarUrl: null,
    confirmedAt: "2025-01-02 03:04:05.123",
    createdAt: "2025-01-01 00:00:00",
    isBanned: false,
    signInCount: 3,
    hasAuthenticationToken: false,
  };
}

function member(
  accountUser: string | null,
  rails: string,
  roles: { member: boolean; owner: boolean },
) {
  return {
    railsAccountUserId: accountUser,
    railsUserId: rails,
    hasMemberRole: roles.member,
    hasOwnerRole: roles.owner,
    createdAt: "2025-02-01 00:00:00",
  };
}

function subscription(
  sub: string,
  account: string,
  status: string,
  quantity: number,
  currentPeriodEnd: string,
  members: ReturnType<typeof member>[],
) {
  return {
    kind: "subscription",
    railsAccountSubscriptionId: sub,
    railsAccountId: account,
    accountName: `Account ${account}`,
    accountSlug: null,
    accountGuid: null,
    status,
    quantity,
    currentPeriodStart: null,
    currentPeriodEnd,
    cancelAtPeriodEnd: false,
    createdAt: "2025-02-01 00:00:00",
    stripeCustomerIdPresent: true,
    stripeSubscriptionIdPresent: true,
    members,
  };
}

function purchase(
  id: string,
  rails: string,
  sellableId: string | null,
  options: { bulk?: boolean } = {},
) {
  return {
    kind: "purchase",
    railsSellablePurchaseId: id,
    railsUserId: rails,
    sellableType: sellableId === null ? null : "Playlist",
    sellableId,
    purchaseState: "paid",
    bulk: options.bulk ?? false,
    restrictedToCountry: null,
    expiresAt: null,
    createdAt: "2026-10-01 00:00:00",
  };
}

/**
 * Rails on flip day (the November export). Matrix:
 *   101 renewed (extended)            9001 active, period end moved to Dec
 *   102 cancelled                     9002 gone from the enabled set
 *   103 new paying user               9003 active, user not in CourseBuilder
 *   104/105/106/107 team seats        9004: owner without seat, kept seat,
 *                                     new seat, removed seat
 *   108 lifetime (role)               lifetime_subscriber granted since July
 *   109 lifetime purchase             playlist purchase, no expiry, new user
 *   110 lapsed but not cancelled      9010 past_due, period ended in August
 *   111 beta signup that bought       links to the CourseBuilder-native user
 *   113 bulk buyer                    bulk pool, no content grant; plus a
 *                                     purchase row with no sellable
 *   114 basic legacy role             ADR-0007 basic grant, new user
 *   115 trialing, role-only member    9014 trialing; account_member role with
 *                                     no account_users row (role membership id)
 *   101 second subscription           9011 on the same account 7001
 *   101 expired purchase              6009 (July row) expired in September
 */
export function novemberExportLines() {
  const users = [
    railsUser("101"),
    railsUser("103"),
    railsUser("104"),
    railsUser("105"),
    railsUser("106"),
    railsUser("108"),
    railsUser("109"),
    railsUser("110"),
    railsUser("111", "Linked@Example.test"),
    railsUser("113"),
    railsUser("114"),
    railsUser("115"),
  ];
  const roleGrants = [{ kind: "role_grant", railsUserId: "108", roleName: "lifetime_subscriber" }];
  const basicGrants = [{ kind: "basic_grant", railsUserId: "114" }];
  const subscriptions = [
    subscription("9001", "7001", "active", 1, "2026-12-31T00:00:00Z", [
      member("8001", "101", { member: true, owner: true }),
    ]),
    subscription("9003", "7003", "active", 1, "2026-12-15T00:00:00Z", [
      member("8003", "103", { member: true, owner: true }),
    ]),
    subscription("9004", "7004", "active", 5, "2026-07-31T00:00:00Z", [
      member("8004", "104", { member: false, owner: true }),
      member("8005", "105", { member: true, owner: false }),
      member("8006", "106", { member: true, owner: false }),
    ]),
    subscription("9010", "7010", "past_due", 1, "2026-08-01T00:00:00Z", [
      member("8010", "110", { member: true, owner: false }),
    ]),
    subscription("9011", "7001", "active", 1, "2026-12-31T00:00:00Z", [
      member("8001", "101", { member: true, owner: true }),
    ]),
    subscription("9014", "7014", "trialing", 1, "2026-12-01T00:00:00Z", [
      member(null, "115", { member: true, owner: false }),
    ]),
  ];
  const purchases = [
    purchase("6001", "109", "555"),
    purchase("6002", "111", "556"),
    purchase("6003", "113", "557", { bulk: true }),
    purchase("6010", "113", null),
  ];
  const manifest = {
    kind: "manifest",
    format: "egghead-rails-access-export/v1",
    exportedAt: "2026-11-19T11:00:00.000Z",
    counts: {
      user: users.length,
      role_grant: roleGrants.length,
      basic_grant: basicGrants.length,
      subscription: subscriptions.length,
      purchase: purchases.length,
    },
  };
  return [...users, ...roleGrants, ...basicGrants, ...subscriptions, ...purchases, manifest].map(
    line,
  );
}

export function novemberExportText() {
  return `${novemberExportLines().join("\n")}\n`;
}

/** The CourseBuilder schema for the four tables the delta touches (drizzle-kit push output). */
export const FIXTURE_DDL = [
  `CREATE TABLE egghead_User (
    id varchar(255) NOT NULL,
    name varchar(255) DEFAULT NULL,
    role varchar(191) NOT NULL DEFAULT 'user',
    email varchar(255) NOT NULL,
    fields json DEFAULT (_utf8mb4'{}'),
    legacyRailsUserId varchar(255) GENERATED ALWAYS AS (json_unquote(json_extract(fields,_utf8mb4'$.legacyRailsUserId'))) STORED,
    legacyContactId varchar(255) GENERATED ALWAYS AS (json_unquote(json_extract(fields,_utf8mb4'$.legacyContactId'))) STORED,
    emailVerified timestamp(3) NULL DEFAULT NULL,
    image varchar(255) DEFAULT NULL,
    createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY egghead_User_email_unique (email),
    UNIQUE KEY legacyRailsUserId_idx (legacyRailsUserId),
    KEY email_idx (email),
    KEY role_idx (role),
    KEY created_at_idx (createdAt),
    KEY legacyContactId_idx (legacyContactId)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE egghead_Entitlement (
    id varchar(191) NOT NULL,
    entitlementType varchar(255) NOT NULL,
    userId varchar(191) DEFAULT NULL,
    organizationId varchar(191) DEFAULT NULL,
    organizationMembershipId varchar(191) DEFAULT NULL,
    sourceType varchar(255) NOT NULL,
    sourceId varchar(191) NOT NULL,
    metadata json DEFAULT (_utf8mb4'{}'),
    expiresAt timestamp(3) NULL DEFAULT NULL,
    createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deletedAt timestamp(3) NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY userId_idx (userId),
    KEY orgId_idx (organizationId),
    KEY source_idx (sourceType, sourceId),
    KEY type_idx (entitlementType),
    KEY idx_Entitlement_on_userId_type_deletedAt (userId, entitlementType, deletedAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE egghead_Organization (
    id varchar(255) NOT NULL,
    name varchar(255) DEFAULT NULL,
    personalOrganizationUserId varchar(255) DEFAULT NULL,
    fields json DEFAULT (_utf8mb4'{}'),
    image varchar(255) DEFAULT NULL,
    createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY personalOrganizationUserId_idx (personalOrganizationUserId),
    KEY created_at_idx (createdAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE egghead_OrganizationMembership (
    id varchar(255) NOT NULL,
    organizationId varchar(191) DEFAULT NULL,
    role varchar(191) NOT NULL DEFAULT 'user',
    invitedById varchar(255) NOT NULL,
    userId varchar(255) NOT NULL,
    personalOrganizationUserId varchar(255) DEFAULT NULL,
    fields json DEFAULT (_utf8mb4'{}'),
    createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY personalOrganizationUserId_idx (personalOrganizationUserId),
    KEY role_idx (role),
    KEY created_at_idx (createdAt),
    KEY organizationId_idx (organizationId)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];

export const FIXTURE_TABLES = [
  "egghead_User",
  "egghead_Entitlement",
  "egghead_Organization",
  "egghead_OrganizationMembership",
];
