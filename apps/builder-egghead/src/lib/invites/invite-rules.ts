/**
 * Rules for the instructor invite chain. Pure, so the security rules are
 * tested directly; the server actions load the invite and apply these.
 */
export type InviteForRules = {
	inviteState: 'INITIATED' | 'VERIFIED' | 'CANCELED' | 'EXPIRED' | 'COMPLETED'
	inviteEmail: string
	acceptedEmail?: string | null
	expiresAt?: Date | string | null
}

const normalize = (email: string) => email.trim().toLowerCase()

const isExpired = (invite: InviteForRules, now: Date) =>
	invite.expiresAt != null && new Date(invite.expiresAt).getTime() <= now.getTime()

/** Why an invite can't be accepted with this email, or null when it can. */
export function acceptanceProblem(
	invite: InviteForRules | null | undefined,
	email: string,
	now: Date = new Date(),
): string | null {
	if (!invite) return 'Invite not found'
	if (invite.inviteState !== 'INITIATED') return 'Invite has already been used or expired'
	if (isExpired(invite, now)) return 'Invite has expired'
	if (normalize(email) !== normalize(invite.inviteEmail)) {
		return 'Use the email address this invite was sent to'
	}
	return null
}

/** Why an instructor profile can't be created from this invite, or null when it can. */
export function profileCreationProblem(
	invite: InviteForRules | null | undefined,
	email: string,
	now: Date = new Date(),
): string | null {
	if (!invite) return 'Invite not found'
	if (invite.inviteState !== 'VERIFIED') return 'Invite is not ready for onboarding'
	if (isExpired(invite, now)) return 'Invite has expired'
	if (!invite.acceptedEmail || normalize(invite.acceptedEmail) !== normalize(invite.inviteEmail)) {
		return 'Invite was not accepted by the invited email'
	}
	if (normalize(email) !== normalize(invite.inviteEmail)) {
		return 'Use the email address this invite was sent to'
	}
	return null
}
