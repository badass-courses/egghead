import { NextResponse } from "next/server";
import { getUserAbilityForRequest } from "@/server/ability-for-request";

export async function GET(request: Request) {
  const { user } = await getUserAbilityForRequest(request);
  if (!user)
    return NextResponse.json(
      { error: "invalid_token" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      },
    );
  return NextResponse.json(user);
}
