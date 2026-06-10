import { mysqlTable } from '@/db/mysql-table'
import {
	getInvitesRelationsSchema,
	getInvitesSchema,
} from '@/db/schemas/invites'
import { getEggheadUsersSchema } from '@/db/schemas/users'

import { getCourseBuilderSchema } from '@coursebuilder/adapter-drizzle/mysql'
import type { MySqlTableFn } from 'drizzle-orm/mysql-core'

export const invites = getInvitesSchema(mysqlTable)
export const invitesRelations = getInvitesRelationsSchema(mysqlTable)

const eggheadCourseBuilderSchema = (
	getCourseBuilderSchema as unknown as (
		mysqlTable: MySqlTableFn,
		overrides: {
			getUsersSchema: typeof getEggheadUsersSchema
		},
	) => ReturnType<typeof getCourseBuilderSchema>
)(mysqlTable, {
	getUsersSchema: getEggheadUsersSchema,
})

export const users = getEggheadUsersSchema(mysqlTable)
export const usersRelations = eggheadCourseBuilderSchema.usersRelations

export const {
	accounts,
	accountsRelations,
	profiles,
	profilesRelations,
	permissions,
	permissionsRelations,
	rolePermissions,
	rolePermissionsRelations,
	roles,
	rolesRelations,
	sessions,
	sessionsRelations,
	userPermissions,
	userPermissionsRelations,
	userRoles,
	userRolesRelations,
	verificationTokens,
	communicationChannel,
	communicationPreferenceTypes,
	communicationPreferences,
	communicationPreferencesRelations,
	contentContributions,
	contentContributionRelations,
	contentResource,
	contentResourceRelations,
	contentResourceVersion,
	contentResourceVersionRelations,
	contentResourceResource,
	contentResourceResourceRelations,
	contributionTypes,
	contributionTypesRelations,
	resourceProgress,
	contentResourceTag,
	contentResourceTagRelations,
	tag,
	tagRelations,
	tagTag,
	tagTagRelations,
	deviceVerifications,
	deviceVerificationRelations,
	deviceAccessToken,
	deviceAccessTokenRelations,
	organization,
	organizationRelations,
	organizationMemberships,
	organizationMembershipRelations,
	organizationMembershipRoles,
	organizationMembershipRolesRelations,

	coupon,
	couponRelations,
	merchantAccount,
	merchantCharge,
	merchantChargeRelations,
	merchantCoupon,
	merchantCustomer,
	merchantPrice,
	merchantProduct,
	merchantSession,
	prices,
	products,
	productRelations,
	purchases,
	purchaseRelations,
	purchaseUserTransfer,
	purchaseUserTransferRelations,
	contentResourceProduct,
	contentResourceProductRelations,

	entitlements,
	entitlementsRelations,
	entitlementTypes,
} = eggheadCourseBuilderSchema
