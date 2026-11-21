import { NextResponse } from "next/server";
import { db } from "@/db";
import { deviceAccessToken, deviceVerifications, users } from "@/db/schema";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { DEVICE_ACCESS_TOKEN_TTL_SECONDS, DEVICE_TOKEN_SCOPE } from "@/server/device-token-policy";

const failure = (error: string, status = 400) =>
  NextResponse.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  );

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure("invalid_request");
  }
  const code = form.get("device_code");
  if (typeof code !== "string" || !code || code.length > 191) return failure("invalid_request");
  const grantType = form.get("grant_type");
  if (grantType !== null && grantType !== "urn:ietf:params:oauth:grant-type:device_code")
    return failure("unsupported_grant_type");
  try {
    return await db.transaction(async (tx) => {
      const grant = await tx.query.deviceVerifications.findFirst({
        where: eq(deviceVerifications.deviceCode, code),
      });
      if (!grant) return failure("access_denied", 403);
      const now = new Date();
      if (!(grant.expires.getTime() > now.getTime())) return failure("expired_token", 403);
      if (!grant.verifiedAt) return failure("authorization_pending", 403);
      if (!grant.verifiedByUserId) return failure("access_denied", 403);
      const user = await tx.query.users.findFirst({
        where: eq(users.id, grant.verifiedByUserId),
      });
      if (!user) return failure("access_denied", 403);
      // Atomic consumption prevents concurrent polls from minting multiple tokens.
      const consumed = await tx
        .delete(deviceVerifications)
        .where(
          and(
            eq(deviceVerifications.deviceCode, code),
            eq(deviceVerifications.verifiedByUserId, user.id),
            isNotNull(deviceVerifications.verifiedAt),
            gt(deviceVerifications.expires, now),
          ),
        );
      if (consumed.rowsAffected !== 1) return failure("access_denied", 403);
      const token = crypto.randomUUID();
      await tx.insert(deviceAccessToken).values({
        userId: user.id,
        token,
        scope: DEVICE_TOKEN_SCOPE,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_ACCESS_TOKEN_TTL_SECONDS * 1000),
        revokedAt: null,
      });
      return NextResponse.json(
        {
          access_token: token,
          token_type: "bearer",
          expires_in: DEVICE_ACCESS_TOKEN_TTL_SECONDS,
          scope: DEVICE_TOKEN_SCOPE,
        },
        { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
      );
    });
  } catch {
    console.warn(
      JSON.stringify({ event: "device_token_issue_failed", reason: "transaction_failed" }),
    );
    return failure("temporarily_unavailable", 503);
  }
}
