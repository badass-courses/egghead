import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { getAuthSecret } from "../coursebuilder/auth-secret";

export const teamInvitePayloadSchema = z.object({
  invitationId: z.string().min(1).max(191),
  email: z
    .string()
    .trim()
    .email()
    .max(255)
    .transform((email) => email.toLowerCase()),
  subscriptionId: z.string().min(1).max(191),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type TeamInvitePayload = z.infer<typeof teamInvitePayloadSchema>;

function signPayload(encodedPayload: string) {
  return createHmac("sha256", getAuthSecret()).update(encodedPayload).digest("base64url");
}

export function createTeamInviteToken(input: TeamInvitePayload) {
  const payload = teamInvitePayloadSchema.parse(input);
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyTeamInviteToken(token: string): TeamInvitePayload | null {
  if (token.length > 4096) return null;
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
    const payload = teamInvitePayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    return payload.expiresAt > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function teamInviteMatchesEmail(payload: TeamInvitePayload, email: string) {
  return payload.email === email.trim().toLowerCase();
}
