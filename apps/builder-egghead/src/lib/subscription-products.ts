import { env } from '@/env.mjs'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter, db } from '@/db'
import {
	assertBuilderCommerceWritesAllowed,
	assertBuilderDatabaseUrlForRuntime,
} from '@/db/runtime-guard'
import { merchantPrice, merchantProduct, prices, products } from '@/db/schema'
import {
	assertStripeTestMode,
	stripeAccountMode,
	type StripeAccountMode,
	type SubscriptionProductFormInput,
} from '@/lib/subscription-products-contracts'
import { getServerAuthSession } from '@/server/auth'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import type { Product } from '@coursebuilder/core/schemas'

const subscriptionProductFieldsSchema = z
	.object({
		billingInterval: z.enum(['month', 'year']).optional(),
		description: z.string().nullable().optional(),
		slug: z.string().optional(),
	})
	.passthrough()

export type SubscriptionProductAdminItem = {
	id: string
	name: string
	description: string
	billingInterval: 'month' | 'year'
	price: number
	currency: string
	active: boolean
	localActive: boolean
	stripeActive: boolean | null
	synced: boolean
	createdAt: string | null
	stripeProductId: string | null
	stripePriceId: string | null
}

export type SubscriptionProductAdminData = {
	products: SubscriptionProductAdminItem[]
	stripeMode: StripeAccountMode
	writesAllowed: boolean
	writeRestriction: string | null
}

type ProductCommerceRecords = {
	merchantProduct: typeof merchantProduct.$inferSelect & { identifier: string }
	merchantPrice: typeof merchantPrice.$inferSelect & {
		identifier: string
		priceId: string
	}
}

async function requireSubscriptionAdmin() {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('manage', 'all')) {
		throw new Error('Unauthorized')
	}
}


function subscriptionWriteCapability() {
	try {
		assertBuilderCommerceWritesAllowed(env.DATABASE_URL)
		assertStripeTestMode(env.STRIPE_SECRET_TOKEN)
		return { writesAllowed: true, writeRestriction: null }
	} catch (error) {
		return {
			writesAllowed: false,
			writeRestriction:
				error instanceof Error
					? error.message
					: 'Subscription product writes are unavailable.',
		}
	}
}

async function getProductCommerceRecords(
	productId: string,
): Promise<ProductCommerceRecords> {
	const storedMerchantProduct = await db.query.merchantProduct.findFirst({
		where: eq(merchantProduct.productId, productId),
	})
	if (!storedMerchantProduct?.identifier) {
		throw new Error('Subscription product is missing its Stripe product mapping.')
	}

	const storedMerchantPrices = await db.query.merchantPrice.findMany({
		where: eq(merchantPrice.merchantProductId, storedMerchantProduct.id),
		orderBy: [desc(merchantPrice.status), desc(merchantPrice.createdAt)],
	})
	const storedMerchantPrice = storedMerchantPrices.at(0)
	if (!storedMerchantPrice?.identifier || !storedMerchantPrice.priceId) {
		throw new Error('Subscription product is missing its Stripe price mapping.')
	}

	return {
		merchantProduct: {
			...storedMerchantProduct,
			identifier: storedMerchantProduct.identifier,
		},
		merchantPrice: {
			...storedMerchantPrice,
			identifier: storedMerchantPrice.identifier,
			priceId: storedMerchantPrice.priceId,
		},
	}
}

async function setSubscriptionProductActive(input: {
	active: boolean
	productId: string
	records: ProductCommerceRecords
}) {
	const paymentsAdapter = stripeProvider.options.paymentsAdapter
	const status = input.active ? 1 : 0

	await paymentsAdapter.updatePrice(input.records.merchantPrice.identifier, {
		active: input.active,
	})
	await paymentsAdapter.updateProduct(input.records.merchantProduct.identifier, {
		active: input.active,
	})

	await db.update(products).set({ status }).where(eq(products.id, input.productId))
	await db.update(prices).set({ status }).where(eq(prices.productId, input.productId))
	await db
		.update(merchantProduct)
		.set({ status })
		.where(eq(merchantProduct.id, input.records.merchantProduct.id))
	await db
		.update(merchantPrice)
		.set({ status: 0 })
		.where(eq(merchantPrice.merchantProductId, input.records.merchantProduct.id))
	if (input.active) {
		await db
			.update(merchantPrice)
			.set({ status })
			.where(eq(merchantPrice.id, input.records.merchantPrice.id))
	}
}

async function prepareProductForAdapterUpdate(
	productId: string,
	records: ProductCommerceRecords,
) {
	await setSubscriptionProductActive({ active: true, productId, records })
}

export async function getSubscriptionProductAdminData(): Promise<SubscriptionProductAdminData> {
	await requireSubscriptionAdmin()
	assertBuilderDatabaseUrlForRuntime(env.DATABASE_URL)
	const writeCapability = subscriptionWriteCapability()

	const storedProducts = await db.query.products.findMany({
		where: eq(products.type, 'membership'),
		orderBy: desc(products.createdAt),
		with: {
			price: true,
			merchantProduct: true,
		},
	})
	const merchantProductIds = storedProducts.flatMap((product) =>
		product.merchantProduct ? [product.merchantProduct.id] : [],
	)
	const storedMerchantPrices = merchantProductIds.length
		? await db.query.merchantPrice.findMany({
				where: inArray(merchantPrice.merchantProductId, merchantProductIds),
				orderBy: [desc(merchantPrice.status), desc(merchantPrice.createdAt)],
			})
		: []
	const merchantPricesByProduct = new Map<string, (typeof storedMerchantPrices)[number]>()
	for (const storedMerchantPrice of storedMerchantPrices) {
		if (!merchantPricesByProduct.has(storedMerchantPrice.merchantProductId)) {
			merchantPricesByProduct.set(
				storedMerchantPrice.merchantProductId,
				storedMerchantPrice,
			)
		}
	}

	const paymentsAdapter = stripeProvider.options.paymentsAdapter
	const adminProducts = await Promise.all(
		storedProducts.map(async (product): Promise<SubscriptionProductAdminItem> => {
			const fields = subscriptionProductFieldsSchema.safeParse(product.fields)
			const merchantProductRecord = product.merchantProduct
			const merchantPriceRecord = merchantProductRecord
				? merchantPricesByProduct.get(merchantProductRecord.id)
				: undefined
			let stripeProductActive: boolean | null = null
			let stripePriceActive: boolean | null = null
			let stripeInterval: 'month' | 'year' | null = null
			let stripePriceAmount: number | null = null
			let currency = 'usd'

			if (merchantProductRecord?.identifier && merchantPriceRecord?.identifier) {
				try {
					const [stripeProduct, stripePrice] = await Promise.all([
						paymentsAdapter.getProduct(merchantProductRecord.identifier),
						paymentsAdapter.getPrice(merchantPriceRecord.identifier),
					])
					stripeProductActive = stripeProduct.active
					stripePriceActive = stripePrice.active
					stripePriceAmount = stripePrice.unit_amount
					currency = stripePrice.currency
					const interval = stripePrice.recurring?.interval
					if (interval === 'month' || interval === 'year') stripeInterval = interval
				} catch {
					stripeProductActive = null
					stripePriceActive = null
				}
			}

			const localPrice = Number(product.price?.unitAmount ?? 0)
			const localInterval = fields.success
				? (fields.data.billingInterval ?? 'year')
				: 'year'
			const localActive =
				product.status === 1 &&
				product.price?.status === 1 &&
				merchantProductRecord?.status === 1 &&
				merchantPriceRecord?.status === 1
			const stripeActive =
				stripeProductActive === null || stripePriceActive === null
					? null
					: stripeProductActive && stripePriceActive
			const stripePriceInMajorUnits =
				stripePriceAmount === null ? null : stripePriceAmount / 100
			const synced =
				stripeActive !== null &&
				localActive === stripeActive &&
				stripeInterval === localInterval &&
				stripePriceInMajorUnits === localPrice

			return {
				id: product.id,
				name: product.name,
				description:
					fields.success && typeof fields.data.description === 'string'
						? fields.data.description
						: '',
				billingInterval: stripeInterval ?? localInterval,
				price: stripePriceInMajorUnits ?? localPrice,
				currency,
				active: stripeActive ?? localActive,
				localActive,
				stripeActive,
				synced,
				createdAt: product.createdAt?.toISOString() ?? null,
				stripeProductId: merchantProductRecord?.identifier ?? null,
				stripePriceId: merchantPriceRecord?.identifier ?? null,
			}
		}),
	)

	return {
		products: adminProducts,
		stripeMode: stripeAccountMode(env.STRIPE_SECRET_TOKEN),
		...writeCapability,
	}
}

export async function createSubscriptionProduct(input: SubscriptionProductFormInput) {
	await requireSubscriptionAdmin()
	assertBuilderCommerceWritesAllowed(env.DATABASE_URL)
	assertStripeTestMode(env.STRIPE_SECRET_TOKEN)

	const product = await courseBuilderAdapter.createProduct({
		name: input.name,
		price: input.price,
		quantityAvailable: -1,
		type: 'membership',
		state: 'published',
		visibility: 'unlisted',
		billingInterval: input.billingInterval,
	})
	if (!product?.price) {
		throw new Error('CourseBuilder did not create the subscription product records.')
	}

	const records = await getProductCommerceRecords(product.id)
	const fields = subscriptionProductFieldsSchema.parse(product.fields)
	await db
		.update(products)
		.set({
			fields: {
				...fields,
				billingInterval: input.billingInterval,
				description: input.description,
			},
		})
		.where(eq(products.id, product.id))
	await stripeProvider.options.paymentsAdapter.updateProduct(
		records.merchantProduct.identifier,
		{
			default_price: records.merchantPrice.identifier,
			description: input.description,
		},
	)
	await setSubscriptionProductActive({
		active: input.active,
		productId: product.id,
		records,
	})

	return product.id
}

export async function updateSubscriptionProduct(input: SubscriptionProductFormInput) {
	await requireSubscriptionAdmin()
	assertBuilderCommerceWritesAllowed(env.DATABASE_URL)
	assertStripeTestMode(env.STRIPE_SECRET_TOKEN)
	if (!input.productId) throw new Error('Subscription product id is required.')

	const currentProduct = await courseBuilderAdapter.getProduct(input.productId, false)
	if (!currentProduct?.price || currentProduct.type !== 'membership') {
		throw new Error('Subscription product was not found.')
	}

	const currentRecords = await getProductCommerceRecords(currentProduct.id)
	const wasActive =
		currentProduct.status === 1 &&
		currentProduct.price.status === 1 &&
		currentRecords.merchantProduct.status === 1 &&
		currentRecords.merchantPrice.status === 1
	await prepareProductForAdapterUpdate(currentProduct.id, currentRecords)

	let updatedProduct: Product | null = null
	try {
		updatedProduct = await courseBuilderAdapter.updateProduct({
			...currentProduct,
			name: input.name,
			status: 1,
			quantityAvailable: -1,
			type: 'membership',
			fields: {
				...currentProduct.fields,
				billingInterval: input.billingInterval,
				description: input.description,
			},
			price: {
				...currentProduct.price,
				status: 1,
				unitAmount: input.price,
			},
		})
	} catch (error) {
		if (!wasActive) {
			await setSubscriptionProductActive({
				active: false,
				productId: currentProduct.id,
				records: currentRecords,
			})
		}
		throw error
	}
	if (!updatedProduct?.price) {
		throw new Error('CourseBuilder did not update the subscription product records.')
	}

	const updatedRecords = await getProductCommerceRecords(updatedProduct.id)
	await db
		.update(prices)
		.set({ unitAmount: input.price.toString() })
		.where(eq(prices.id, updatedProduct.price.id))
	await setSubscriptionProductActive({
		active: input.active,
		productId: updatedProduct.id,
		records: updatedRecords,
	})

	return updatedProduct.id
}
