import { NextResponse } from "next/server";
import { db } from "@/db";
import { deviceVerifications } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hri } from "human-readable-ids";
import { v4 } from "uuid";
import { DEVICE_GRANT_TTL_SECONDS } from "@/server/device-token-policy";

export async function POST() {
  const expires = new Date(Date.now() + DEVICE_GRANT_TTL_SECONDS * 1000);

  const userCode = hri.random();
  const deviceCode = v4();

  await db.insert(deviceVerifications).values({
    userCode,
    deviceCode,
    createdAt: new Date(),
    expires,
  });

  const deviceVerification = await db.query.deviceVerifications.findFirst({
    where: eq(deviceVerifications.deviceCode, deviceCode),
  });

  if (!deviceVerification) {
    return NextResponse.json({ error: "Device verification not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      device_code: deviceVerification.deviceCode,
      user_code: deviceVerification.userCode,
      verification_uri: `${process.env.NEXT_PUBLIC_URL}/activate`,
      verification_uri_complete: `${process.env.NEXT_PUBLIC_URL}/activate?user_code=${deviceVerification.userCode}`,
      expires_in: DEVICE_GRANT_TTL_SECONDS,
      interval: 5,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
