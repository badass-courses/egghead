import type { CourseBuilderAdapter } from "@coursebuilder/core/adapters";

type PersonalOrganizationUser = {
  id: string;
  email: string;
};

export async function ensurePersonalOrganization(
  user: PersonalOrganizationUser,
  adapter: CourseBuilderAdapter,
) {
  const memberships = await adapter.getMembershipsForUser(user.id);
  const existingMembership = memberships[0];

  if (existingMembership?.organizationId) {
    return {
      organization: existingMembership.organization,
      membership: existingMembership,
    };
  }

  const organization = await adapter.createOrganization({
    name: `Personal (${user.email})`,
  });

  if (!organization) {
    throw new Error("Unable to create a personal organization for checkout.");
  }

  const membership = await adapter.addMemberToOrganization({
    organizationId: organization.id,
    userId: user.id,
    invitedById: user.id,
  });

  if (!membership) {
    throw new Error("Unable to create an organization membership for checkout.");
  }

  await adapter.addRoleForMember({
    organizationId: organization.id,
    memberId: membership.id,
    role: "owner",
  });

  return { organization, membership };
}
