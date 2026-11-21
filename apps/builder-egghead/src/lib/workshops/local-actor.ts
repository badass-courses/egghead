import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import {
  authenticateDevice,
  bearerDeviceToken,
  logDeviceAuthenticationFailure,
} from "@/server/device-identity";
import { subject } from "@casl/ability";
import * as schema from "@/db/schema";
import { assertLocalWorkshopRuntime } from "./mysql-store";
import { WorkshopActor } from "@egghead/core/workshops";

/** Reuses device-token identity and CASL permissions with the local MySQL driver. */
export async function localWorkshopActor(databaseUrl: string, bearer: string | null) {
  assertLocalWorkshopRuntime(databaseUrl);
  if (!bearerDeviceToken(bearer)) return null;
  const connection = await mysql.createConnection(databaseUrl).catch(() => {
    logDeviceAuthenticationFailure("connection_failed");
    return null;
  });
  if (!connection) return null;
  try {
    const database = drizzle(connection, { schema, mode: "default" });
    const identity = await authenticateDevice(bearer, (token) =>
      database.query.deviceAccessToken.findFirst({
        where: eq(schema.deviceAccessToken.token, token),
        with: { verifiedBy: { with: { roles: { with: { role: true } } } } },
      }),
    );
    if (!identity) return null;
    const { ability, user } = identity;
    if (!ability.can("create", "Content")) return null;
    return WorkshopActor.of({
      id: user.id,
      canCreate: ability.can("create", "Content"),
      canManageAll: ability.can("manage", "all"),
      canManage: (workshop) => ability.can("manage", subject("Content", workshop)),
    });
  } finally {
    await connection.end();
  }
}
