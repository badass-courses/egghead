import type { OAuthConfig, OAuthUserConfig } from '@auth/core/providers'
import type { TokenSet } from '@auth/core/types'

export interface EggheadProfile extends Record<string, any> {
	id: number | string
	name?: string | null
	full_name?: string | null
	email?: string | null
	avatar_url?: string | null
	instructor_id?: number
	roles?: string[] | null
	instructor?: {
		id: number
		first_name: string
		last_name: string
		avatar_url: string
		email: string
		slug: string
	}
}

function toAuthUserRole(name: string) {
	return {
		id: name,
		name,
		description: null,
		active: true,
		createdAt: null,
		updatedAt: null,
		deletedAt: null,
	}
}

function normalizeEggheadProfile(profile: EggheadProfile): EggheadProfile {
	return {
		...profile,
		roles: Array.isArray(profile.roles) ? profile.roles : [],
	}
}

export default function egghead(
	config: OAuthUserConfig<EggheadProfile>,
): OAuthConfig<EggheadProfile> {
	return {
		id: 'egghead',
		name: 'egghead',
		type: 'oauth',
		token: 'https://app.egghead.io/oauth/token',
		authorization: {
			url: 'https://app.egghead.io/oauth/authorize?response_type=code',
			params: { scope: '' },
		},
		userinfo: {
			url: 'https://app.egghead.io/api/v1/users/current',
			async request({
				tokens,
				provider,
			}: {
				tokens: TokenSet
				provider: OAuthConfig<EggheadProfile>
			}) {
				if (!provider.userinfo?.url) {
					throw new Error('Missing egghead userinfo URL')
				}

				const response = await fetch(provider.userinfo.url, {
					headers: {
						Authorization: `Bearer ${tokens.access_token}`,
						'User-Agent': 'authjs',
					},
				})

				if (!response.ok) {
					throw new Error(
						`egghead userinfo request failed with status ${response.status}`,
					)
				}

				return normalizeEggheadProfile(await response.json())
			},
		},
		profile(profile: EggheadProfile) {
			if (!profile.email) {
				throw new Error('Egghead profile is missing an email address')
			}

			return {
				id: String(profile.id),
				name: profile.name || profile.full_name || profile.email,
				email: profile.email,
				image: profile.avatar_url || null,
				roles: (profile.roles || []).map(toAuthUserRole),
			}
		},
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		allowDangerousEmailAccountLinking: config.allowDangerousEmailAccountLinking,
	}
}
