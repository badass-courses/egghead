import { createHash } from "node:crypto";
import { getAbility, UserSchema, type User } from "@/ability";

type Assignment = {
  active: boolean;
  deletedAt: Date | null;
  role: User["roles"][number];
};
export type DeviceIdentityRow = {
  revokedAt: Date | null;
  expiresAt: Date | null;
  verifiedBy: ({ roles: Assignment[] } & Record<string, unknown>) | null;
};

export function bearerDeviceToken(bearer: string | null) {
  return bearer?.match(/^Bearer (\S+)$/i)?.[1] ?? null;
}

export function logDeviceAuthenticationFailure(
  reason: "lookup_failed" | "connection_failed" | "revocation_failed",
) {
  // Never log the exception: database errors can contain SQL, credentials or bearer values.
  console.warn(JSON.stringify({ event: "device_authentication_denied", reason }));
}

/** One token policy for bearer APIs, production content MCP and local Workshops. */
export async function authenticateDevice(
  bearer: string | null,
  lookup: (token: string) => Promise<DeviceIdentityRow | undefined>,
  now = Date.now(),
) {
  const token = bearerDeviceToken(bearer);
  if (!token) return null;
  let row: DeviceIdentityRow | undefined;
  try {
    row = await lookup(token);
  } catch {
    logDeviceAuthenticationFailure("lookup_failed");
    return null;
  }
  if (
    !row?.verifiedBy ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && !(row.expiresAt.getTime() > now))
  )
    return null;
  const parsed = UserSchema.safeParse({
    ...row.verifiedBy,
    roles: row.verifiedBy.roles
      .filter((assignment) => assignment.active && !assignment.deletedAt)
      .map(({ role }) => role)
      .filter((role) => role.active && !role.deletedAt),
  });
  if (!parsed.success || parsed.data.roles.length === 0) return null;
  return {
    user: parsed.data,
    ability: getAbility({ user: parsed.data }),
    // The schema's primary key is the secret token, not a separate ID. Hash it before auditing.
    tokenId: createHash("sha256").update(token).digest("hex"),
  };
}
