/**
 * Account-linking guard for the Rails `egghead` OAuth provider.
 *
 * The provider keeps Auth.js email linking on, because builder users were
 * projected from Rails without `egghead` Account rows. Email alone does not
 * prove ownership, though. An unlinked sign-in may attach to an existing user
 * only when that user's projected `legacyRailsUserId` equals the Rails user id
 * the provider returned (the OAuth provider account id).
 */
export type EggheadEmailLinkCandidate = {
	id: string
	legacyRailsUserId: string | null
}

export type EggheadEmailLinkDecision =
	| {
			allow: true
			reason: 'linked-account' | 'new-user' | 'legacy-rails-id-match'
	  }
	| {
			allow: false
			reason: 'legacy-rails-id-mismatch' | 'no-legacy-rails-id'
	  }

export function decideEggheadEmailLink(input: {
	linkedUserId: string | null
	emailUser: EggheadEmailLinkCandidate | null
	providerAccountId: string
}): EggheadEmailLinkDecision {
	if (input.linkedUserId) return { allow: true, reason: 'linked-account' }
	if (!input.emailUser) return { allow: true, reason: 'new-user' }

	const legacyRailsUserId = input.emailUser.legacyRailsUserId?.trim()
	if (!legacyRailsUserId) return { allow: false, reason: 'no-legacy-rails-id' }
	if (legacyRailsUserId === input.providerAccountId.trim()) {
		return { allow: true, reason: 'legacy-rails-id-match' }
	}

	return { allow: false, reason: 'legacy-rails-id-mismatch' }
}
