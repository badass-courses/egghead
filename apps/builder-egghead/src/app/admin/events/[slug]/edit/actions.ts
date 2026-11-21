'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContentEditor } from '@/server/require-editor'

import { ContentResource } from '@coursebuilder/core/schemas'

export const onEventSave = async (resource: ContentResource) => {
	'use server'
	await requireContentEditor()
	revalidatePath(`/admin/events/${resource.fields?.slug}`)
	// redirect(`/admin/events/${resource.fields?.slug}`)
}
