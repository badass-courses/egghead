import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getEggheadDatabase } from "../db/adapter";
import {
  organization,
  organizationMembershipRoles,
  organizationMemberships,
  roles,
} from "../db/schema";

type PersonalOrganizationUser = {
  id: string;
  email: string;
};

export async function ensurePersonalOrganization(user: PersonalOrganizationUser) {
  const db = getEggheadDatabase();
  const organizationName = `egghead-personal:${user.id}`;
  const key = createHash("sha256").update(user.id).digest("hex");

  return db.transaction(async (transaction) => {
    const existingOrganization = await transaction.query.organization.findFirst({
      where: eq(organization.name, organizationName),
    });
    const organizationId = existingOrganization?.id ?? `egghead-personal-org:${key}`;
    const existingMembership = await transaction.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, user.id),
      ),
      with: { organization: true },
    });
    const membershipId = existingMembership?.id ?? `egghead-personal-membership:${key}`;

    if (!existingOrganization) {
      await transaction
        .insert(organization)
        .values({
          id: organizationId,
          name: organizationName,
        })
        .onDuplicateKeyUpdate({
          set: { name: organizationName },
        });
    }

    if (!existingMembership) {
      await transaction
        .insert(organizationMemberships)
        .values({
          id: membershipId,
          invitedById: user.id,
          organizationId,
          userId: user.id,
        })
        .onDuplicateKeyUpdate({
          set: {
            invitedById: user.id,
            organizationId,
            userId: user.id,
          },
        });
    }

    const ownerRoleId = `egghead-personal-owner:${key}`;
    await transaction
      .insert(roles)
      .values({
        id: ownerRoleId,
        name: "owner",
        organizationId,
      })
      .onDuplicateKeyUpdate({
        set: {
          active: true,
          deletedAt: null,
        },
      });

    const ownerRole = await transaction.query.roles.findFirst({
      where: and(eq(roles.organizationId, organizationId), eq(roles.name, "owner")),
    });
    if (!ownerRole) {
      throw new Error("Unable to ensure the personal organization owner role.");
    }

    await transaction
      .insert(organizationMembershipRoles)
      .values({
        organizationId,
        organizationMembershipId: membershipId,
        roleId: ownerRole.id,
      })
      .onDuplicateKeyUpdate({
        set: {
          active: true,
          deletedAt: null,
          organizationId,
        },
      });

    const membership = await transaction.query.organizationMemberships.findFirst({
      where: eq(organizationMemberships.id, membershipId),
      with: { organization: true },
    });
    if (!membership?.organization) {
      throw new Error("Unable to ensure a personal organization for checkout.");
    }

    return {
      organization: membership.organization,
      membership,
    };
  });
}
