import { courseBuilderAdapter, db } from '@/db'
import { contentResource, contentResourceProduct } from '@/db/schema'
import {
	attachProductToEvent,
	buildWorkshopConfig,
	checkDrift,
	detachProductFromEvent,
	exportWorkshopConfig,
	readEdgeConfigState,
	reviewPageUrl,
	setSaleLive,
	writeWorkshopConfig,
} from '@/lib/egghead-sale/publish'
import {
	executeSale,
	planSale,
	resolveCommerceForEvent,
} from '@/lib/egghead-sale/stripe'
import { EventSchema, type Event } from '@/lib/events'
import { createEventAs, updateEventAs, type Actor } from '@/lib/events-mutations'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * MCP tools for scheduling an egghead live workshop end to end.
 *
 * Every write tool is a dry run unless `confirm: true`. The model is expected
 * to show the returned plan to the operator and ask before confirming.
 */

type ToolResult = {
	content: Array<{ type: 'text'; text: string }>
	isError?: boolean
}

function ok(payload: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error)
	return { isError: true, content: [{ type: 'text', text: message }] }
}

async function loadEvent(slugOrId: string): Promise<Event> {
	const data = await courseBuilderAdapter.getEvent(slugOrId, {
		withResources: true,
		withTags: true,
		withProducts: true,
		withPricing: true,
	})
	const parsed = EventSchema.safeParse(data)
	if (!parsed.success) {
		throw new Error(`No event found for "${slugOrId}".`)
	}
	return parsed.data
}

function summarize(event: Event) {
	return {
		id: event.id,
		slug: event.fields.slug,
		title: event.fields.title,
		state: event.fields.state,
		visibility: event.fields.visibility,
		startsAt: event.fields.startsAt ?? null,
		endsAt: event.fields.endsAt ?? null,
		timezone: event.fields.timezone ?? null,
		productId: event.resourceProducts?.[0]?.productId ?? null,
		calendarId: event.fields.calendarId ?? null,
		eggheadSale: event.fields.eggheadSale
			? {
					flagKey: event.fields.eggheadSale.flagKey,
					paymentLinkUrl: event.fields.eggheadSale.paymentLinkUrl,
					promoCodes: {
						member: event.fields.eggheadSale.promoCodes.member.code,
						earlyBird: event.fields.eggheadSale.promoCodes.earlyBird.code,
						earlyBirdMember: event.fields.eggheadSale.promoCodes.earlyBirdMember.code,
					},
					approvedBy: event.fields.eggheadSale.approvedBy ?? null,
					approvedAt: event.fields.eggheadSale.approvedAt ?? null,
				}
			: null,
		reviewPage: reviewPageUrl(event.fields.slug),
	}
}

const isoDateTime = z
	.string()
	.datetime({ offset: true })
	.describe('ISO 8601 with offset, e.g. 2026-09-18T09:00:00-07:00')

const confirmField = z
	.boolean()
	.default(false)
	.describe(
		'false returns a dry-run plan and changes nothing. Show the plan to the operator and ask before calling again with true.',
	)

export function registerWorkshopTools(server: McpServer, actor: Actor) {
	server.registerTool(
		'list_workshops',
		{
			title: 'List workshops',
			description:
				'List Builder events (live workshops) with schedule, product, and egghead sale status. Read-only.',
			inputSchema: {
				includePast: z.boolean().default(false).describe('Include events that already ended'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ includePast }) => {
			try {
				const rows = await db
					.select()
					.from(contentResource)
					.where(and(eq(contentResource.type, 'event'), isNull(contentResource.deletedAt)))
					.orderBy(desc(contentResource.createdAt))
					.limit(100)
				const ids = rows.map((row) => row.id)
				const products = ids.length
					? await db
							.select()
							.from(contentResourceProduct)
							.where(inArray(contentResourceProduct.resourceId, ids))
					: []
				const now = Date.now()
				const events = rows
					.map((row) => {
						const parsed = EventSchema.safeParse({
							...row,
							resourceProducts: products.filter((p) => p.resourceId === row.id),
						})
						return parsed.success ? parsed.data : null
					})
					.filter((event): event is Event => event !== null)
					.filter((event) => {
						if (includePast) return true
						const end = event.fields.endsAt ?? event.fields.startsAt
						return !end || new Date(end).getTime() >= now
					})
					.map(summarize)
				return ok({ count: events.length, events })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'get_workshop',
		{
			title: 'Get workshop',
			description:
				'Full detail for one event: fields, Course Builder product and Stripe ids, and what egghead.io currently has in Edge Config. Read-only.',
			inputSchema: { slug: z.string().describe('Event slug or id') },
			annotations: { readOnlyHint: true },
		},
		async ({ slug }) => {
			try {
				const event = await loadEvent(slug)
				const commerce = await resolveCommerceForEvent(event).catch((error: Error) => ({
					error: error.message,
				}))
				const edgeConfig = event.fields.eggheadSale
					? await readEdgeConfigState(event.fields.eggheadSale.flagKey).catch(
							(error: Error) => ({ error: error.message }),
						)
					: null
				return ok({
					...summarize(event),
					description: event.fields.description ?? null,
					details: event.fields.details ?? null,
					attendeeInstructions: event.fields.attendeeInstructions ?? null,
					image: event.fields.image ?? null,
					commerce,
					eggheadSale: event.fields.eggheadSale ?? null,
					edgeConfig,
				})
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'create_workshop',
		{
			title: 'Create workshop',
			description:
				'Create a draft event. With a price > 0 the Builder also creates the Product, Price, Stripe product and Stripe price, and Google Calendar sync starts. Dry run unless confirm is true.',
			inputSchema: {
				title: z.string().min(2).max(90),
				description: z.string().max(500).optional(),
				startsAt: isoDateTime,
				endsAt: isoDateTime,
				timezone: z
					.string()
					.default('America/Los_Angeles')
					.describe('IANA zone the times are shown in on egghead.io'),
				price: z.number().min(0).describe('Full price in USD. 0 creates no product.'),
				seats: z.number().int().min(-1).default(-1).describe('Seat cap. -1 means unlimited.'),
				confirm: confirmField,
			},
		},
		async ({ title, description, startsAt, endsAt, timezone, price, seats, confirm }) => {
			try {
				const start = new Date(startsAt)
				const end = new Date(endsAt)
				if (end <= start) {
					throw new Error('endsAt must be after startsAt.')
				}
				const plan = {
					title,
					description: description ?? null,
					startsAt: start.toISOString(),
					endsAt: end.toISOString(),
					timezone,
					price,
					seats,
					willCreateStripeProduct: price > 0,
					state: 'draft',
					visibility: 'unlisted',
				}
				if (!confirm) {
					return ok({ dryRun: true, plan })
				}
				const created = await createEventAs(
					{
						type: 'event',
						fields: {
							title,
							description: description ?? undefined,
							startsAt: start,
							endsAt: end,
							price,
							quantity: seats,
						},
					},
					actor,
				)
				await updateEventAs({ id: created.id, fields: { timezone } }, 'save', actor)
				const event = await loadEvent(created.id)
				const commerce =
					price > 0
						? await resolveCommerceForEvent(event).catch((error: Error) => ({
								error: error.message,
							}))
						: null
				return ok({ dryRun: false, event: summarize(event), commerce })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'update_workshop',
		{
			title: 'Update workshop',
			description:
				'Change schedule or copy on an existing event. Only supplied fields change. Dry run unless confirm is true.',
			inputSchema: {
				slug: z.string(),
				title: z.string().min(2).max(90).optional(),
				description: z.string().optional(),
				details: z.string().optional().describe('Markdown; becomes the calendar description'),
				attendeeInstructions: z.string().optional(),
				startsAt: isoDateTime.optional(),
				endsAt: isoDateTime.optional(),
				timezone: z.string().optional(),
				image: z.string().url().optional(),
				confirm: confirmField,
			},
		},
		async ({ slug, confirm, ...changes }) => {
			try {
				const event = await loadEvent(slug)
				const fields: Partial<Event['fields']> = {}
				if (changes.title !== undefined) fields.title = changes.title
				if (changes.description !== undefined) fields.description = changes.description
				if (changes.details !== undefined) fields.details = changes.details
				if (changes.attendeeInstructions !== undefined)
					fields.attendeeInstructions = changes.attendeeInstructions
				if (changes.startsAt !== undefined)
					fields.startsAt = new Date(changes.startsAt).toISOString()
				if (changes.endsAt !== undefined) fields.endsAt = new Date(changes.endsAt).toISOString()
				if (changes.timezone !== undefined) fields.timezone = changes.timezone
				if (changes.image !== undefined) fields.image = changes.image
				if (Object.keys(fields).length === 0) {
					throw new Error('Nothing to change.')
				}
				const before = Object.fromEntries(
					Object.keys(fields).map((key) => [key, event.fields[key as keyof Event['fields']]]),
				)
				if (!confirm) {
					return ok({ dryRun: true, slug: event.fields.slug, before, after: fields })
				}
				await updateEventAs({ id: event.id, fields }, 'save', actor)
				return ok({ dryRun: false, event: summarize(await loadEvent(event.id)) })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'attach_product',
		{
			title: 'Attach product to workshop',
			description:
				'Repair tool. For an event that has no product (the Builder logged and skipped a failure at creation), create the Product, Price, Stripe product and Stripe price and link them to the event. Dry run unless confirm is true.',
			inputSchema: {
				slug: z.string(),
				price: z.number().min(0.01).describe('Full price in USD'),
				seats: z.number().int().min(-1).describe('Seat cap. -1 means unlimited.'),
				confirm: confirmField,
			},
		},
		async ({ slug, price, seats, confirm }) => {
			try {
				const event = await loadEvent(slug)
				if (event.resourceProducts && event.resourceProducts.length > 0) {
					throw new Error(
						`Event ${event.fields.slug} already has product ${event.resourceProducts[0]?.productId}. Nothing to attach.`,
					)
				}
				if (!confirm) {
					return ok({
						dryRun: true,
						slug: event.fields.slug,
						wouldCreate: {
							product: { name: event.fields.title, type: 'live', price, quantityAvailable: seats },
							stripe: { product: event.fields.title, price: `$${price} usd one-time` },
						},
					})
				}
				const { productId } = await attachProductToEvent(event, { price, seats }, actor)
				const refreshed = await loadEvent(event.id)
				const commerce = await resolveCommerceForEvent(refreshed)
				return ok({ dryRun: false, productId, commerce })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'reset_product',
		{
			title: 'Reset workshop product',
			description:
				'Repair tool. Unlink the event\'s product and retire its Course Builder rows so attach_product can create a fresh product, price, and Stripe objects. Use when the Stripe product or price was deleted by hand. Touches nothing in Stripe. Dry run unless confirm is true.',
			inputSchema: { slug: z.string(), confirm: confirmField },
		},
		async ({ slug, confirm }) => {
			try {
				const event = await loadEvent(slug)
				const productId = event.resourceProducts?.[0]?.productId ?? null
				if (!productId) {
					throw new Error(`Event ${event.fields.slug} has no product. Run attach_product.`)
				}
				if (!confirm) {
					return ok({
						dryRun: true,
						slug: event.fields.slug,
						wouldDetach: productId,
						then: 'Run attach_product to create a fresh product and Stripe objects.',
					})
				}
				const result = await detachProductFromEvent(event, actor)
				return ok({ dryRun: false, ...result, next: 'attach_product' })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'create_sale',
		{
			title: 'Create egghead sale',
			description:
				'Create the Stripe Payment Link and the yearly-member, non-member-early-bird, and member-early-bird coupons for an event that already has a price, then record them on the event. Coupon names follow previous workshops (<prefix>-<MM-DD>-...) and Stripe generates the promo codes. Dry run unless confirm is true; the dry run lists recent existing coupons so the naming can be checked.',
			inputSchema: {
				slug: z.string(),
				flagKey: z
					.string()
					.regex(/^featureFlag[A-Za-z0-9]+$/)
					.describe('egghead-next feature flag, e.g. featureFlagClaudeCodeWorkshopSale'),
				couponNamePrefix: z
					.string()
					.min(1)
					.describe(
						'Coupon name prefix used on previous workshops, e.g. "asfw" for Software Factory or "CC" for Claude Code. Names become <prefix>-<MM-DD>-yearly-member-discount, -non-member-early-bird, -member-early-bird.',
					),
				memberCode: z.string().optional().describe('Explicit promo code; omit to let Stripe generate one like previous workshops'),
				earlyBirdCode: z.string().optional(),
				earlyBirdMemberCode: z.string().optional(),
				expireEarlyBirdCodes: z
					.boolean()
					.default(false)
					.describe('Previous workshops never expired early-bird codes in Stripe; the page stops offering them after earlyBirdEndDate'),
				memberDiscount: z.number().min(0).describe('USD off for yearly and lifetime members'),
				earlyBirdDiscount: z.number().min(0).describe('USD off before earlyBirdEndDate'),
				earlyBirdMemberDiscount: z.number().min(0).describe('USD off for members before earlyBirdEndDate'),
				earlyBirdEndDate: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe('YYYY-MM-DD; early-bird codes expire at 23:59 that day in the event timezone'),
				isEuFriendly: z.boolean().default(false),
				bannerMessage: z.string().optional(),
				earlyBirdBannerMessage: z.string().optional(),
				afterCompletionUrl: z.string().url().optional().describe('Redirect after checkout, if existing links use one'),
				confirm: confirmField,
			},
		},
		async ({ slug, confirm, ...options }) => {
			try {
				const event = await loadEvent(slug)
				const plan = await planSale(event, options)
				if (!confirm) {
					return ok({
						dryRun: true,
						slug: event.fields.slug,
						commerce: plan.commerce,
						paymentLink: plan.paymentLink.reuseUrl
							? { reuse: plan.paymentLink.reuseUrl }
							: { create: { price: plan.commerce.stripePriceId, metadataProductId: plan.commerce.stripeProductId } },
						promoCodes: plan.promoCodes,
						recentExistingCodes: plan.existingCodes,
					})
				}
				const sale = await executeSale(plan)
				await updateEventAs({ id: event.id, fields: { eggheadSale: sale } }, 'save', actor)
				return ok({ dryRun: false, sale, reviewPage: reviewPageUrl(event.fields.slug) })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'export_egghead_config',
		{
			title: 'Export egghead.io config to paste',
			description:
				'Return the exact Edge Config key names and JSON for this event so the operator can paste them into the Vercel dashboard by hand. Use this when the Builder has no Edge Config credentials. Read-only; touches nothing.',
			inputSchema: {
				slug: z.string(),
				isSaleLive: z
					.boolean()
					.default(false)
					.describe('true to produce the on-sale version of both keys'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ slug, isSaleLive }) => {
			try {
				const event = await loadEvent(slug)
				return ok(await exportWorkshopConfig(event, isSaleLive))
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'write_egghead_config',
		{
			title: 'Write egghead.io config',
			description:
				'Build the workshop JSON egghead.io reads from Edge Config and upsert it. Keeps the current isSaleLive value; use go_live to put it on sale. Dry run unless confirm is true.',
			inputSchema: { slug: z.string(), confirm: confirmField },
		},
		async ({ slug, confirm }) => {
			try {
				const event = await loadEvent(slug)
				if (!confirm) {
					const { flagKey, workshop, current } = await buildWorkshopConfig(event)
					return ok({ dryRun: true, flagKey, workshop, currentlyInEdgeConfig: current })
				}
				const written = await writeWorkshopConfig(event)
				return ok({ dryRun: false, ...written, reviewPage: reviewPageUrl(event.fields.slug) })
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'go_live',
		{
			title: 'Go live on egghead.io',
			description:
				'Put the workshop on sale: sets isSaleLive and the header banner flag together and records who approved it. Refuses without confirm: true. Always ask the operator first.',
			inputSchema: { slug: z.string(), confirm: confirmField },
		},
		async ({ slug, confirm }) => {
			try {
				const event = await loadEvent(slug)
				if (!confirm) {
					const { flagKey, workshop } = await buildWorkshopConfig(event, true)
					return ok({
						dryRun: true,
						refused: 'go_live needs confirm: true. Show this to the operator and ask.',
						flagKey,
						wouldWrite: { [`${flagKey}_workshop`]: workshop, [`${flagKey}_saleBanner`]: true },
					})
				}
				return ok(await setSaleLive(event, true, actor))
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'end_sale',
		{
			title: 'End sale on egghead.io',
			description:
				'Take the workshop off sale: sets isSaleLive and the header banner flag to false together. Refuses without confirm: true.',
			inputSchema: { slug: z.string(), confirm: confirmField },
		},
		async ({ slug, confirm }) => {
			try {
				const event = await loadEvent(slug)
				if (!confirm) {
					return ok({ dryRun: true, refused: 'end_sale needs confirm: true.' })
				}
				return ok(await setSaleLive(event, false, actor))
			} catch (error) {
				return fail(error)
			}
		},
	)

	server.registerTool(
		'check_drift',
		{
			title: 'Check drift',
			description:
				'Compare the Builder event, Stripe, and Edge Config and list every field that disagrees. Read-only. Run before go_live and whenever something looks off on egghead.io.',
			inputSchema: { slug: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ slug }) => {
			try {
				const event = await loadEvent(slug)
				return ok(await checkDrift(event))
			} catch (error) {
				return fail(error)
			}
		},
	)
}
