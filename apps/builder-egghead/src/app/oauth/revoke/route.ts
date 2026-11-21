import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deviceAccessToken } from "@/db/schema";
import { getUserAbilityForRequest } from "@/server/ability-for-request";
import { bearerDeviceToken, logDeviceAuthenticationFailure } from "@/server/device-identity";

export async function POST(request: Request) {
  const { user } = await getUserAbilityForRequest(request);
  const token = bearerDeviceToken(request.headers.get("Authorization"));
  if (!user || !token) return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  try {
    await db
      .update(deviceAccessToken)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(deviceAccessToken.token, token),
          eq(deviceAccessToken.userId, user.id),
          isNull(deviceAccessToken.revokedAt),
        ),
      );
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    logDeviceAuthenticationFailure("revocation_failed");
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }
}
