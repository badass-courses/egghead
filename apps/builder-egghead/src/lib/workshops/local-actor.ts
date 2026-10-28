import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { subject } from "@casl/ability";
import { getAbility, UserSchema } from "@/ability";
import * as schema from "@/db/schema";
import { assertLocalWorkshopRuntime } from "./mysql-store";
import { WorkshopActor } from "@egghead/core/workshops";

/** Reuses device-token identity and CASL permissions with the local MySQL driver. */
export async function localWorkshopActor(databaseUrl: string, bearer: string | null) {
  assertLocalWorkshopRuntime(databaseUrl);
  const token = bearer?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return null;
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const database = drizzle(connection, { schema, mode: "default" });
    const deviceToken = await database.query.deviceAccessToken.findFirst({
      where: and(
        eq(schema.deviceAccessToken.token, token),
        isNull(schema.deviceAccessToken.revokedAt),
        or(
          isNull(schema.deviceAccessToken.expiresAt),
          gt(schema.deviceAccessToken.expiresAt, sql`CURRENT_TIMESTAMP(3)`),
        ),
      ),
      with: { verifiedBy: { with: { roles: { with: { role: true } } } } },
    });
    if (!deviceToken?.verifiedBy) return null;
    const parsed = UserSchema.safeParse({
      ...deviceToken.verifiedBy,
      roles: deviceToken.verifiedBy.roles
        .filter((assignment) => assignment.active && !assignment.deletedAt)
        .map(({ role }) => role)
        .filter((role) => role.active && !role.deletedAt),
    });
    if (!parsed.success) return null;
    const ability = getAbility({ user: parsed.data });
    if (!ability.can("create", "Content")) return null;
    return WorkshopActor.of({
      id: parsed.data.id,
      canCreate: ability.can("create", "Content"),
      canManageAll: ability.can("manage", "all"),
      canManage: (workshop) => ability.can("manage", subject("Content", workshop)),
    });
  } finally {
    await connection.end();
  }
}
