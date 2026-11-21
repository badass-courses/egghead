import { NextRequest } from "next/server";
import { getAbility } from "@/ability";
import { authenticateDevice } from "./device-identity";
import { db } from "@/db";
import { deviceAccessToken } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function getUserAbilityForRequest(request: NextRequest) {
  const identity = await authenticateDevice(request.headers.get("Authorization"), (token) =>
    db.query.deviceAccessToken.findFirst({
      where: eq(deviceAccessToken.token, token),
      with: {
        verifiedBy: {
          with: {
            roles: {
              with: {
                role: true,
              },
            },
          },
        },
      },
    }),
  );
  return identity ?? { user: null, ability: getAbility(), tokenId: null };
}
