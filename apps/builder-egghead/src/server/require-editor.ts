import 'server-only'

import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'
import { eq } from 'drizzle-orm'

import type { ContentResource } from '@coursebuilder/core/schemas'

/**
 * Server-action guard: the caller must be signed in with permission to create
 * content (contributor or admin). Throws before any read or write happens.
 */
export async function requireContentEditor() {
	const { session, ability } = await getServerAuthSession()

	if (!session?.user?.id || ability.cannot('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	return { session, ability, userId: session.user.id }
}

/**
 * Server-action guard for changes to one content resource: the caller must be
 * an editor who may manage that resource (its creator, or an admin).
 */
export async function requireCanManageResource(resourceId: string) {
	const guard = await requireContentEditor()
	const resource = await db.query.contentResource.findFirst({
		where: eq(contentResource.id, resourceId),
	})

	if (!resource || guard.ability.cannot('manage', subject('Content', resource as ContentResource))) {
		throw new Error('Unauthorized')
	}

	return { ...guard, resource }
}

/**
 * Server-action guard for admin-only work, such as inviting instructors.
 */
export async function requireAdmin() {
	const { session, ability } = await getServerAuthSession()

	if (!session?.user?.id || ability.cannot('manage', 'all')) {
		throw new Error('Unauthorized')
	}

	return { session, ability, userId: session.user.id }
}
