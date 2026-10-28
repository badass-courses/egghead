import { z } from "zod";

export const MIN_TEAM_SEATS = 2;
export const MAX_TEAM_SEATS = 100;

export const subscriptionCheckoutQuantitySchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_TEAM_SEATS);

export const teamSubscriptionFieldsSchema = z.object({
  ownerId: z.string().min(1),
  membershipKind: z.enum(["individual", "team"]).optional(),
  seats: z.coerce.number().int().min(1).max(MAX_TEAM_SEATS),
});

export type TeamSubscriptionFields = z.infer<typeof teamSubscriptionFieldsSchema>;

export function isTeamSubscription(fields: unknown) {
  const parsedFields = teamSubscriptionFieldsSchema.safeParse(fields);
  return (
    parsedFields.success &&
    (parsedFields.data.membershipKind === "team" ||
      (!parsedFields.data.membershipKind && parsedFields.data.seats >= MIN_TEAM_SEATS))
  );
}
