import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { requireAuthSecret } from "../coursebuilder/auth-secret";

const teamInvitePayloadSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(255)
    .transform((email) => email.toLowerCase())
    .optional(),
  subscriptionId: z.string().min(1).max(191),
});

export type TeamInvitePayload = z.infer<typeof teamInvitePayloadSchema>;

function signPayload(encodedPayload: string) {
  return createHmac("sha256", requireAuthSecret()).update(encodedPayload).digest("base64url");
}

export function createTeamInviteToken(subscriptionId: string, email?: string) {
  const payload = teamInvitePayloadSchema.parse({ email, subscriptionId });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyTeamInviteToken(token: string): TeamInvitePayload | null {
  const [encodedPayload, signature, extraPart] = token.split(".");
  if (!encodedPayload || !signature || extraPart !== undefined) return null;

  const expectedSignature = Buffer.from(signPayload(encodedPayload));
  const receivedSignature = Buffer.from(signature);
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    return null;
  }

  try {
    return teamInvitePayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export function teamInviteMatchesEmail(payload: TeamInvitePayload, email: string) {
  return payload.email === undefined || payload.email === email.trim().toLowerCase();
}
