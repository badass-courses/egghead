'use server'

import { revalidatePath } from 'next/cache'
import { reviewPagePath, setSaleLive } from '@/lib/egghead-sale/publish'
import { getEvent } from '@/lib/events-query'
import { getServerAuthSession } from '@/server/auth'

async function toggleSale(slug: string, live: boolean) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (!user || !ability.can('manage', 'Content')) {
		throw new Error('Unauthorized')
	}
	const event = await getEvent(slug)
	if (!event) {
		throw new Error(`Event ${slug} not found`)
	}
	const result = await setSaleLive(event, live, { user, ability })
	revalidatePath(reviewPagePath(slug))
	return result
}

export async function goLiveAction(formData: FormData) {
	const slug = String(formData.get('slug') ?? '')
	await toggleSale(slug, true)
}

export async function endSaleAction(formData: FormData) {
	const slug = String(formData.get('slug') ?? '')
	await toggleSale(slug, false)
}
