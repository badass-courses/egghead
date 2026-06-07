import { courseBuilderConfig } from "../apps/web/src/coursebuilder/config";
import { getCurrentUser } from "../apps/web/src/coursebuilder/current-user";
import { EGGHEAD_TABLE_PREFIX, getEggheadTableName } from "../apps/web/src/db/mysql-table";
import { entitlements, entitlementTypes, resourceProgress, users } from "../apps/web/src/db/schema";

const currentUser = await getCurrentUser();

console.log(
  JSON.stringify({
    ok: true,
    app: "egghead",
    courseBuilder: {
      basePath: courseBuilderConfig.basePath,
      baseUrl: courseBuilderConfig.baseUrl,
      providers: courseBuilderConfig.providers.length,
      hasAdapter: Boolean(courseBuilderConfig.adapter),
      hasGetCurrentUser: typeof courseBuilderConfig.getCurrentUser === "function",
      currentUser,
    },
    schema: {
      prefix: EGGHEAD_TABLE_PREFIX,
      sampleTables: [
        getEggheadTableName("User"),
        getEggheadTableName("ResourceProgress"),
        getEggheadTableName("Entitlement"),
        getEggheadTableName("EntitlementType"),
      ],
      exportsLoad: Boolean(users && resourceProgress && entitlements && entitlementTypes),
    },
    guardrails: {
      localDevOnly: true,
      commerceExcluded: true,
      stripeWriterUnchanged: true,
      inngestWriterUnchanged: true,
      readFlipBlocked: true,
      planetScaleWritesApproved: false,
    },
  }),
);
