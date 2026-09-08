import { courseBuilderAdapter, db } from '@/db'
import {
	contentResourceProduct,
	merchantPrice,
	merchantProduct,
	prices,
	products,
} from '@/db/schema'
import { env } from '@/env.mjs'
import { and, eq } from 'drizzle-orm'
import { updateEventAs, type Actor } from '@/lib/events-mutations'
import type { Event } from '@/lib/events'

import {
	isEdgeConfigConfigured,
	readItems,
	saleBannerKey,
	upsertItems,
	workshopKey,
} from './edge-config'
import { buildLiveWorkshop, LiveWorkshopSchema, type LiveWorkshop } from './live-workshop'
import { readStripeSaleState, resolveCommerceForEvent } from './stripe'

/**
 * Bridge between a Builder event and the live egghead.io sale:
 * write the Edge Config JSON, flip the flags, and report drift.
 */

export function reviewPagePath(slug: string) {
	return `/admin/events/${slug}/egghead-sale`
}

export function reviewPageUrl(slug: string) {
	return `${env.COURSEBUILDER_URL}${reviewPagePath(slug)}`
}

function requireSale(event: Event) {
	const sale = event.fields.eggheadSale
	if (!sale) {
		throw new Error(
			`Event ${event.fields.slug} has no egghead sale yet. Run create_sale first.`,
		)
	}
	return sale
}

export type EdgeConfigState = {
	configured: boolean
	workshop: LiveWorkshop | null
	workshopRaw: unknown
	workshopValid: boolean
	saleBanner: boolean | null
}

/** Read what egghead.io currently sees for this event's flag. */
export async function readEdgeConfigState(flagKey: string): Promise<EdgeConfigState> {
	if (!isEdgeConfigConfigured()) {
		return {
			configured: false,
			workshop: null,
			workshopRaw: null,
			workshopValid: false,
			saleBanner: null,
		}
	}
	const items = await readItems([workshopKey(flagKey), saleBannerKey(flagKey)])
	const raw = items[workshopKey(flagKey)]
	const parsed = LiveWorkshopSchema.safeParse(raw)
	const banner = items[saleBannerKey(flagKey)]
	return {
		configured: true,
		workshop: parsed.success ? parsed.data : null,
		workshopRaw: raw ?? null,
		workshopValid: parsed.success,
		saleBanner: typeof banner === 'boolean' ? banner : null,
	}
}

/** Build the JSON egghead.io expects, using the current sale-live state unless overridden. */
export async function buildWorkshopConfig(event: Event, isSaleLive?: boolean) {
	const sale = requireSale(event)
	const commerce = await resolveCommerceForEvent(event)
	const current = await readEdgeConfigState(sale.flagKey)
	const live = isSaleLive ?? current.workshop?.isSaleLive ?? false
	return {
		flagKey: sale.flagKey,
		workshop: buildLiveWorkshop({
			event,
			sale,
			isSaleLive: live,
			workshopPrice: commerce.price,
		}),
		current,
	}
}

/**
 * Create the Course Builder product, price, and Stripe product/price for an
 * event that has none, and link them. This is the same adapter call the
 * event workflow makes, minus the try/catch that hides its failures.
 */
export async function attachProductToEvent(
	event: Event,
	options: { price: number; seats: number },
	actor: Actor,
) {
	if (!actor.ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}
	if (event.resourceProducts && event.resourceProducts.length > 0) {
		throw new Error(
			`Event ${event.fields.slug} already has product ${event.resourceProducts[0]?.productId}.`,
		)
	}
	const product = await courseBuilderAdapter.createProduct({
		name: event.fields.title,
		price: options.price,
		quantityAvailable: options.seats,
		type: 'live',
		state: 'published',
		visibility: 'public',
	})
	if (!product) {
		throw new Error('createProduct returned nothing. Check the Builder log for the Stripe or database error.')
	}
	const link = await courseBuilderAdapter.addResourceToProduct({
		resource: event,
		productId: product.id,
		userId: actor.user.id,
	})
	if (!link) {
		throw new Error(`Product ${product.id} was created but could not be linked to ${event.fields.slug}.`)
	}
	return { productId: product.id }
}

/**
 * Unlink the event's product and retire its rows (status 0) so a fresh one
 * can be attached. Used when the Stripe side was deleted by hand. Nothing is
 * hard-deleted and nothing is touched in Stripe.
 */
export async function detachProductFromEvent(event: Event, actor: Actor) {
	if (!actor.ability.can('manage', 'Content')) {
		throw new Error('Unauthorized')
	}
	const productId = event.resourceProducts?.[0]?.productId
	if (!productId) {
		throw new Error(`Event ${event.fields.slug} has no product to detach.`)
	}

	const merchantProducts = await db
		.select({ id: merchantProduct.id })
		.from(merchantProduct)
		.where(eq(merchantProduct.productId, productId))

	await db
		.delete(contentResourceProduct)
		.where(
			and(
				eq(contentResourceProduct.resourceId, event.id),
				eq(contentResourceProduct.productId, productId),
			),
		)
	for (const row of merchantProducts) {
		await db
			.update(merchantPrice)
			.set({ status: 0 })
			.where(eq(merchantPrice.merchantProductId, row.id))
	}
	await db.update(merchantProduct).set({ status: 0 }).where(eq(merchantProduct.productId, productId))
	await db.update(prices).set({ status: 0 }).where(eq(prices.productId, productId))
	await db.update(products).set({ status: 0 }).where(eq(products.id, productId))

	return { detachedProductId: productId, retiredMerchantProducts: merchantProducts.length }
}

export class EdgeConfigNotConfiguredError extends Error {
	constructor() {
		super(
			'Edge Config is not configured on this Builder. Use export_egghead_config to get the keys and JSON to paste into Vercel by hand.',
		)
		this.name = 'EdgeConfigNotConfiguredError'
	}
}

function requireEdgeConfig() {
	if (!isEdgeConfigConfigured()) {
		throw new EdgeConfigNotConfiguredError()
	}
}

/**
 * The exact Edge Config items for this event, for pasting into the Vercel
 * dashboard when the Builder has no write access. Works without any
 * Vercel credentials.
 */
export async function exportWorkshopConfig(event: Event, isSaleLive: boolean) {
	const sale = requireSale(event)
	const commerce = await resolveCommerceForEvent(event)
	const workshop = buildLiveWorkshop({
		event,
		sale,
		isSaleLive,
		workshopPrice: commerce.price,
	})
	return {
		flagKey: sale.flagKey,
		items: [
			{ key: workshopKey(sale.flagKey), value: workshop },
			{ key: saleBannerKey(sale.flagKey), value: isSaleLive },
		],
		instructions: [
			'In Vercel: the egghead team, Storage, the Edge Config store egghead-next uses, then Items.',
			`Set "${workshopKey(sale.flagKey)}" to the JSON value below (replace the whole value).`,
			`Set "${saleBannerKey(sale.flagKey)}" to ${isSaleLive}.`,
			'Save both together. egghead.io picks the change up within about 60 seconds.',
			'Then run check_drift here; it will skip the Edge Config comparison, so verify on egghead.io directly.',
		],
	}
}

/** Upsert `<flag>_workshop`. Leaves the banner flag alone. */
export async function writeWorkshopConfig(event: Event, isSaleLive?: boolean) {
	requireEdgeConfig()
	const { flagKey, workshop } = await buildWorkshopConfig(event, isSaleLive)
	await upsertItems([{ key: workshopKey(flagKey), value: workshop }])
	return { flagKey, workshop }
}

/**
 * Flip `isSaleLive` and `<flag>_saleBanner` together in one PATCH, and
 * record who approved it on the event.
 */
export async function setSaleLive(event: Event, live: boolean, actor: Actor) {
	const sale = requireSale(event)
	requireEdgeConfig()
	const { workshop } = await buildWorkshopConfig(event, live)
	await upsertItems([
		{ key: workshopKey(sale.flagKey), value: workshop },
		{ key: saleBannerKey(sale.flagKey), value: live },
	])

	const approvedAt = new Date().toISOString()
	await updateEventAs(
		{
			id: event.id,
			fields: {
				eggheadSale: {
					...sale,
					approvedBy: live ? actor.user.email ?? actor.user.id : sale.approvedBy,
					approvedAt: live ? approvedAt : sale.approvedAt,
				},
			},
		},
		'save',
		actor,
	)

	return {
		flagKey: sale.flagKey,
		isSaleLive: live,
		saleBanner: live,
		approvedBy: live ? actor.user.email ?? actor.user.id : null,
		approvedAt: live ? approvedAt : null,
		reviewPage: reviewPageUrl(event.fields.slug),
	}
}

export type DriftMismatch = {
	field: string
	builder: unknown
	stripe?: unknown
	edgeConfig?: unknown
}

export type DriftReport = {
	ok: boolean
	checkedAt: string
	mismatches: DriftMismatch[]
	notes: string[]
}

/**
 * Compare the Builder record, Stripe, and Edge Config for one event.
 * Read-only.
 */
export async function checkDrift(event: Event): Promise<DriftReport> {
	const sale = requireSale(event)
	const mismatches: DriftMismatch[] = []
	const notes: string[] = []

	const commerce = await resolveCommerceForEvent(event)
	const stripeState = await readStripeSaleState(sale)
	const edge = await readEdgeConfigState(sale.flagKey)

	if (commerce.stripeProductId !== sale.stripeProductId) {
		mismatches.push({
			field: 'stripeProductId',
			builder: commerce.stripeProductId,
			stripe: sale.stripeProductId,
		})
	}
	if (!stripeState.paymentLink) {
		mismatches.push({ field: 'paymentLink', builder: sale.paymentLinkId, stripe: null })
	} else if (!stripeState.paymentLink.active) {
		mismatches.push({
			field: 'paymentLink.active',
			builder: true,
			stripe: false,
		})
	}
	if (stripeState.price && stripeState.price.unitAmount !== commerce.price) {
		mismatches.push({
			field: 'price',
			builder: commerce.price,
			stripe: stripeState.price.unitAmount,
		})
	}
	for (const role of ['member', 'earlyBird', 'earlyBirdMember'] as const) {
		const recorded = sale.promoCodes[role]
		const live = stripeState.promoCodes.find((code) => code.role === role)
		if (!live) {
			mismatches.push({ field: `promoCodes.${role}`, builder: recorded.code, stripe: null })
			continue
		}
		if (!live.active) {
			mismatches.push({ field: `promoCodes.${role}.active`, builder: true, stripe: false })
		}
		if (live.amountOff !== recorded.amountOff) {
			mismatches.push({
				field: `promoCodes.${role}.amountOff`,
				builder: recorded.amountOff,
				stripe: live.amountOff,
			})
		}
	}

	if (!edge.configured) {
		notes.push('Edge Config is not configured in this environment; skipped that comparison.')
	} else if (!edge.workshopValid) {
		mismatches.push({
			field: 'edgeConfig.workshop',
			builder: 'valid LiveWorkshop JSON',
			edgeConfig: edge.workshopRaw === null ? 'missing' : 'does not match LiveWorkshopSchema',
		})
	} else if (edge.workshop) {
		const expected = buildLiveWorkshop({
			event,
			sale,
			isSaleLive: edge.workshop.isSaleLive,
			workshopPrice: commerce.price,
		})
		for (const key of Object.keys(expected) as Array<keyof LiveWorkshop>) {
			if (expected[key] !== edge.workshop[key]) {
				mismatches.push({
					field: `edgeConfig.${key}`,
					builder: expected[key],
					edgeConfig: edge.workshop[key],
				})
			}
		}
		if (edge.saleBanner !== edge.workshop.isSaleLive) {
			mismatches.push({
				field: 'edgeConfig.saleBanner',
				builder: edge.workshop.isSaleLive,
				edgeConfig: edge.saleBanner,
			})
		}
	}

	return {
		ok: mismatches.length === 0,
		checkedAt: new Date().toISOString(),
		mismatches,
		notes,
	}
}
