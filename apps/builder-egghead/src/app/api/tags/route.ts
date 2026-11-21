import { NextResponse } from "next/server";
import { getUserAbilityForRequest } from "@/server/ability-for-request";
import { getAllEggheadTagsCached } from "@/lib/tags-query";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET(request: Request) {
  if (request.headers.has("Authorization")) {
    const { user } = await getUserAbilityForRequest(request);
    if (!user)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: { ...corsHeaders, "Cache-Control": "no-store" } },
      );
  }
  const tags = await getAllEggheadTagsCached();
  return NextResponse.json(tags, { headers: corsHeaders });
}
