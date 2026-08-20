import { z } from 'zod'

const stripeTestSecretPattern = /^(?:rk|sk)_test_/

const subscriptionPriceSchema = z.coerce
	.number()
	.positive('Price must be greater than zero.')
	.max(1_000_000, 'Price is too large.')
	.refine(
		(value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
		'Price must have at most two decimal places.',
	)

export const subscriptionProductFormSchema = z.object({
	productId: z.string().trim().min(1).optional(),
	name: z.string().trim().min(2).max(90),
	description: z.string().trim().max(500),
	billingInterval: z.enum(['month', 'year']),
	price: subscriptionPriceSchema,
	active: z.boolean(),
})

export type SubscriptionProductFormInput = z.infer<
	typeof subscriptionProductFormSchema
>

export function parseSubscriptionProductForm(
	formData: FormData,
): SubscriptionProductFormInput {
	const productId = formData.get('productId')

	return subscriptionProductFormSchema.parse({
		...(typeof productId === 'string' && productId ? { productId } : {}),
		name: formData.get('name'),
		description: formData.get('description'),
		billingInterval: formData.get('billingInterval'),
		price: formData.get('price'),
		active: formData.get('active') === 'on',
	})
}

export function stripeUnitAmount(price: number) {
	return Math.round(price * 100)
}

export type StripeAccountMode = 'live' | 'test' | 'unknown'

export function stripeAccountMode(secret: string | undefined): StripeAccountMode {
	if (!secret) return 'unknown'
	if (stripeTestSecretPattern.test(secret)) return 'test'
	if (/^(?:rk|sk)_live_/.test(secret)) return 'live'
	return 'unknown'
}

export function assertStripeTestMode(secret: string | undefined) {
	if (stripeAccountMode(secret) !== 'test') {
		throw new Error('Subscription product writes require Stripe test mode.')
	}
}
