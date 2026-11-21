'use server'

import { INSTRUCTOR_INVITE_CREATED_EVENT } from '@/inngest/events/instructor-invite-created'
import { inngest } from '@/inngest/inngest.server'
import { requireAdmin } from '@/server/require-editor'
import { z } from 'zod'

export async function inviteInstructor(rawEmail: unknown) {
	// Only admins may invite instructors: an invite ends in a contributor role
	// and a legacy egghead instructor record.
	const { userId } = await requireAdmin()
	const email = z.string().trim().email().parse(rawEmail)

	await inngest.send({
		name: INSTRUCTOR_INVITE_CREATED_EVENT,
		data: {
			email,
			invitedById: userId,
		},
	})
}
