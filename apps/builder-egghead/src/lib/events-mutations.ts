import { revalidateTag } from 'next/cache'
import type { AppAbility } from '@/ability'
import { courseBuilderAdapter } from '@/db'
import {
	EventSchema,
	EventSeriesSchema,
	type Event,
	type EventFormData,
} from '@/lib/events'
import { guid } from '@coursebuilder/utils/guid'
import { subject } from '@casl/ability'
import slugify from '@sindresorhus/slugify'

import {
	RESOURCE_CREATED_EVENT,
	RESOURCE_UPDATED_EVENT,
} from '../inngest/events/resource-management'
import { inngest } from '../inngest/inngest.server'

/**
 * Who is performing a mutation. Resolved from the browser session by the
 * server actions in `events-query.ts`, or from a bearer token by the MCP route.
 * Never accept an actor from a client payload.
 */
export type Actor = {
	user: { id: string; email?: string | null; name?: string | null }
	ability: AppAbility
}

export type EventAction = 'save' | 'publish' | 'archive' | 'unpublish'

async function loadEventOrSeries(eventIdOrSlug: string) {
	const eventData = await courseBuilderAdapter.getEvent(eventIdOrSlug, {
		withResources: true,
		withTags: true,
		withProducts: true,
		withPricing: true,
	})

	if (eventData?.type === 'event') {
		const parsed = EventSchema.safeParse(eventData)
		return parsed.success ? parsed.data : null
	}
	if (eventData?.type === 'event-series') {
		const parsed = EventSeriesSchema.safeParse(eventData)
		return parsed.success ? parsed.data : null
	}
	return null
}

/**
 * Create an event (and, when `fields.price > 0`, its Product, Price and the
 * matching Stripe product and price) on behalf of an explicit actor.
 */
export async function createEventAs(input: EventFormData, actor: Actor) {
	if (!actor.ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const event = await courseBuilderAdapter.createEvent(input, actor.user.id)

	if (!event) {
		throw new Error('Failed to create event')
	}

	try {
		await inngest.send({
			name: RESOURCE_CREATED_EVENT,
			data: { id: event.id, type: event.type },
		})
	} catch (error) {
		console.error(`Error dispatching ${RESOURCE_CREATED_EVENT}`, error)
	}

	return event
}

/**
 * Merge `input.fields` into an existing event on behalf of an explicit actor.
 * `action` is checked against the actor's ability and drives slug handling.
 */
export type EventUpdateInput = {
	id?: string
	fields?: Partial<Event['fields']>
}

export async function updateEventAs(
	input: EventUpdateInput,
	action: EventAction,
	actor: Actor,
	revalidate = true,
) {
	if (!input.id) {
		throw new Error('Event id is required')
	}

	const currentEvent = await loadEventOrSeries(input.id)

	if (!currentEvent) {
		console.error('event.update.notfound', {
			eventId: input.id,
			userId: actor.user.id,
			action,
		})
		throw new Error(`Event with id ${input.id} not found.`)
	}

	if (!actor.ability.can(action, subject('Content', currentEvent))) {
		console.error('event.update.unauthorized', {
			eventId: input.id,
			userId: actor.user.id,
			action,
		})
		throw new Error('Unauthorized')
	}

	let eventSlug = currentEvent.fields.slug

	if (
		input.fields?.title !== undefined &&
		input.fields.title !== currentEvent.fields.title &&
		input.fields?.slug?.includes('~')
	) {
		const splitSlug = currentEvent.fields.slug.split('~') || ['', guid()]
		eventSlug = `${slugify(input.fields.title)}~${splitSlug[1] || guid()}`
		console.log('event.update.slug.changed', {
			eventId: input.id,
			oldSlug: currentEvent.fields.slug,
			newSlug: eventSlug,
			userId: actor.user.id,
		})
	} else if (
		input.fields?.slug !== undefined &&
		input.fields.slug !== currentEvent.fields.slug
	) {
		eventSlug = input.fields.slug || ''
		console.log('event.update.slug.manual', {
			eventId: input.id,
			oldSlug: currentEvent.fields.slug,
			newSlug: eventSlug,
			userId: actor.user.id,
		})
	}

	try {
		const updatedEvent = await courseBuilderAdapter.updateContentResourceFields(
			{
				id: currentEvent.id,
				fields: {
					...currentEvent.fields,
					...input.fields,
					slug: eventSlug,
				},
			},
		)

		if (!updatedEvent) {
			console.error(`Failed to fetch updated event: ${currentEvent.id}`)
			return null
		}

		console.log('event.update.success', {
			eventId: input.id,
			action,
			userId: actor.user.id,
			changes: Object.keys(input.fields || {}),
		})

		if (revalidate) {
			revalidateTag('events', 'max')
		}

		try {
			await inngest.send({
				name: RESOURCE_UPDATED_EVENT,
				data: { id: updatedEvent.id, type: updatedEvent.type },
			})
		} catch (error) {
			console.error(`Error dispatching ${RESOURCE_UPDATED_EVENT}`, error)
		}

		return updatedEvent
	} catch (error) {
		console.error('event.update.failed', {
			eventId: input.id,
			action,
			userId: actor.user.id,
		})
		throw error
	}
}
