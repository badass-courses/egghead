import { NextResponse } from "next/server";

import { getEggheadRuntime } from "../../../db/local-docker";
import {
  EGGHEAD_REHEARSAL_COHORT_COOKIE,
  normalizeRehearsalCohort,
} from "../../../coursebuilder/rehearsal-cohort";

function safeReturnPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function stringFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : null;
}

export async function POST(request: Request) {
  const runtime = getEggheadRuntime();

  if (runtime === "production") {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const formData = await request.formData();
  const cohort = normalizeRehearsalCohort(stringFormValue(formData.get("cohort")));
  const returnTo = safeReturnPath(formData.get("returnTo"));

  if (!cohort) {
    return Response.json({ ok: false, error: "invalid_cohort" }, { status: 400 });
  }

  const response = NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });

  if (cohort === "anonymous") {
    response.cookies.delete(EGGHEAD_REHEARSAL_COHORT_COOKIE);
    return response;
  }

  response.cookies.set(EGGHEAD_REHEARSAL_COHORT_COOKIE, cohort, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
    sameSite: "lax",
    secure: runtime === "beta",
  });

  return response;
}
