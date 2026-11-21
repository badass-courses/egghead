'use server'

import { redirect } from 'next/navigation'
import { db } from '@/db'
import { invites } from '@/db/schema'
import { acceptanceProblem } from '@/lib/invites/invite-rules'
import { eq } from 'drizzle-orm'

interface AcceptInstructorInviteParams {
	inviteId: string
	email: string
}

export async function acceptInstructorInvite({
	inviteId,
	email,
}: AcceptInstructorInviteParams) {
	const invite = await db.query.invites.findFirst({
		where: eq(invites.id, inviteId),
		columns: {
			inviteEmail: true,
			inviteState: true,
			expiresAt: true,
		},
	})

	const problem = acceptanceProblem(invite, String(email ?? ''))
	if (problem || !invite) {
		throw new Error(problem ?? 'Invite not found')
	}

	await db
		.update(invites)
		.set({
			inviteState: 'VERIFIED',
			acceptedEmail: invite.inviteEmail,
			confirmedAt: new Date(),
		})
		.where(eq(invites.id, inviteId))

	redirect(`/invites/${inviteId}/onboarding`)
}
