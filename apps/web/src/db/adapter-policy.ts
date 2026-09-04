import type { CourseBuilderAdapter } from "@coursebuilder/core/adapters";
import type { AuthStoragePort, UserProvisioningPort } from "@coursebuilder/core/auth";
import type { MySqlDatabase } from "drizzle-orm/mysql-core";
import type { Adapter } from "next-auth/adapters";
import {
  assertAccountWritesAllowed,
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
  assertProgressWritesAllowed,
  getDatabaseUrl,
  RuntimePolicyError,
} from "./local-docker";

export type PublishedAdapter = CourseBuilderAdapter<typeof MySqlDatabase> &
  AuthStoragePort &
  UserProvisioningPort &
  Adapter;

function unsupported(): never {
  throw new RuntimePolicyError("Unsupported CourseBuilder adapter operation.");
}

/** Explicitly expose the audited 2.1.1 methods; never spread a published adapter.
 * New package entrypoints remain absent until their effects have been reviewed.
 */
export function withAdapterRuntimePolicy(source: PublishedAdapter): PublishedAdapter {
  const targetUrl = getDatabaseUrl();
  function guard<Key extends keyof PublishedAdapter>(
    key: Key,
    assertAllowed: (rawUrl?: string) => unknown,
  ) {
    const method = source[key];
    if (typeof method !== "function") return unsupported;
    // A function-only proxy retains the published overloads without a type
    // assertion. The explicit object below remains the operation allowlist.
    return new Proxy(method, {
      apply(target, _receiver: unknown, args: unknown[]) {
        assertAllowed(targetUrl);
        if (getDatabaseUrl() !== targetUrl) {
          throw new RuntimePolicyError(
            "Database target changed after adapter initialization; restart required.",
          );
        }
        const result: unknown = Reflect.apply(target, source, args);
        return result;
      },
    });
  }

  const read = <Key extends keyof PublishedAdapter>(key: Key) =>
    guard(key, assertDatabaseUrlForRuntime);
  const account = <Key extends keyof PublishedAdapter>(key: Key) =>
    guard(key, assertAccountWritesAllowed);
  const progress = <Key extends keyof PublishedAdapter>(key: Key) =>
    guard(key, assertProgressWritesAllowed);
  const commerce = <Key extends keyof PublishedAdapter>(key: Key) =>
    guard(key, assertCommerceWritesAllowed);

  const adapter: PublishedAdapter = {
    // No package action in 2.0.2 consumes client. Do not leak a raw SQL bypass.
    get client(): never {
      return unsupported();
    },
    // createUser internally provisions its personal organization; that is one
    // account operation, not permission to mutate arbitrary team memberships.
    provisionPersonalOrganization: account("provisionPersonalOrganization"),
    createUser: account("createUser"),
    findOrCreateUser: account("findOrCreateUser"),
    updateUser: account("updateUser"),
    deleteUser: account("deleteUser"),
    createSession: account("createSession"),
    updateSession: account("updateSession"),
    deleteSession: account("deleteSession"),
    linkAccount: account("linkAccount"),
    unlinkAccount: account("unlinkAccount"),
    createVerificationToken: account("createVerificationToken"),
    useVerificationToken: account("useVerificationToken"),
    getUser: read("getUser"),
    getUserByEmail: read("getUserByEmail"),
    getUserByAccount: read("getUserByAccount"),
    getUserById: read("getUserById"),
    getSessionAndUser: read("getSessionAndUser"),
    getUserWithPurchasersByEmail: read("getUserWithPurchasersByEmail"),
    completeLessonProgressForUser: progress("completeLessonProgressForUser"),
    toggleLessonProgressForUser: progress("toggleLessonProgressForUser"),
    clearLessonProgressForUser: unsupported,
    getLessonProgressForUser: read("getLessonProgressForUser"),
    getModuleProgressForUser: read("getModuleProgressForUser"),
    getLessonProgressCountsByDate: unsupported,
    getLessonProgresses: unsupported,
    getExistingNonBulkValidPurchasesOfProduct: read("getExistingNonBulkValidPurchasesOfProduct"),
    getMerchantAccount: read("getMerchantAccount"),
    getMerchantPriceForProductId: read("getMerchantPriceForProductId"),
    getMerchantProductForProductId: read("getMerchantProductForProductId"),
    getMerchantCustomerForUserId: read("getMerchantCustomerForUserId"),
    getUpgradableProducts: read("getUpgradableProducts"),
    availableUpgradesForProduct: read("availableUpgradesForProduct"),
    couponForIdOrCode: read("couponForIdOrCode"),
    getMerchantEventByIdentifier: read("getMerchantEventByIdentifier"),
    getMerchantEventsByAccount: read("getMerchantEventsByAccount"),
    getCoupon: read("getCoupon"),
    getPurchasesForBulkCouponId: read("getPurchasesForBulkCouponId"),
    getCouponWithBulkPurchases: read("getCouponWithBulkPurchases"),
    getDefaultCoupon: read("getDefaultCoupon"),
    getMerchantCharge: read("getMerchantCharge"),
    getMerchantCouponsForTypeAndPercent: read("getMerchantCouponsForTypeAndPercent"),
    getMerchantCouponForTypeAndPercent: read("getMerchantCouponForTypeAndPercent"),
    getMerchantCouponForTypeAndAmount: read("getMerchantCouponForTypeAndAmount"),
    getMerchantCoupon: read("getMerchantCoupon"),
    getMerchantProduct: read("getMerchantProduct"),
    getPrice: unsupported,
    getPriceForProduct: read("getPriceForProduct"),
    getProduct: read("getProduct"),
    getProductResources: read("getProductResources"),
    getPurchaseCountForProduct: read("getPurchaseCountForProduct"),
    getPurchase: read("getPurchase"),
    getPurchaseForStripeCharge: read("getPurchaseForStripeCharge"),
    getPurchaseByCheckoutSessionId: read("getPurchaseByCheckoutSessionId"),
    getPurchaseUserTransferById: read("getPurchaseUserTransferById"),
    getPurchaseWithUser: read("getPurchaseWithUser"),
    getPurchasesForUser: read("getPurchasesForUser"),
    getEntitlementsForUser: read("getEntitlementsForUser"),
    getEntitlementTypeByName: read("getEntitlementTypeByName"),
    getPurchaseDetails: read("getPurchaseDetails"),
    pricesOfPurchasesTowardOneBundle: read("pricesOfPurchasesTowardOneBundle"),
    getVideoResource: read("getVideoResource"),
    getParentResourceOfVideoResource: read("getParentResourceOfVideoResource"),
    getContentResource: read("getContentResource"),
    getEvent: read("getEvent"),
    getOrganization: read("getOrganization"),
    getMembershipsForUser: read("getMembershipsForUser"),
    getOrganizationMembers: read("getOrganizationMembers"),
    getMerchantSubscription: read("getMerchantSubscription"),
    getSubscriptionForStripeId: read("getSubscriptionForStripeId"),
    createMerchantCustomer: commerce("createMerchantCustomer"),
    findOrCreateMerchantCustomer: commerce("findOrCreateMerchantCustomer"),
    createMerchantSession: commerce("createMerchantSession"),
    createMerchantEvent: commerce("createMerchantEvent"),
    createOrganization: commerce("createOrganization"),
    addMemberToOrganization: commerce("addMemberToOrganization"),
    removeMemberFromOrganization: commerce("removeMemberFromOrganization"),
    addRoleForMember: commerce("addRoleForMember"),
    removeRoleForMember: commerce("removeRoleForMember"),
    createSubscription: commerce("createSubscription"),
    createMerchantSubscription: commerce("createMerchantSubscription"),
    updateSubscriptionStatus: commerce("updateSubscriptionStatus"),
    // Legacy purchase/admin mutations are not part of this app's writer contract.
    redeemFullPriceCoupon: unsupported,
    createPurchaseTransfer: unsupported,
    incrementCouponUsedCount: unsupported,
    createMerchantCoupon: unsupported,
    createMerchantChargeAndPurchase: unsupported,
    archiveProduct: unsupported,
    updateProduct: unsupported,
    createProduct: unsupported,
    createPurchase: unsupported,
    transferPurchaseToUser: unsupported,
    transferPurchasesToNewUser: unsupported,
    updatePurchaseStatusForCharge: unsupported,
    updatePurchaseUserTransferTransferState: unsupported,
    addResourceToResource: unsupported,
    removeResourceFromResource: unsupported,
    updateContentResourceFields: unsupported,
    createContentResource: unsupported,
    addResourceToProduct: unsupported,
    createEvent: unsupported,
    createEventSeries: unsupported,
    createCohort: unsupported,
    createWorkshop: unsupported,
    createCoupon: unsupported,
    updateMerchantSubscription: unsupported,
    deleteMerchantSubscription: unsupported,
  };
  // Auth.js copies adapter methods. The denied raw-client getter must not run
  // during that copy, nor become an unguarded data property on the copy.
  Object.defineProperty(adapter, "client", { enumerable: false });
  return adapter;
}
