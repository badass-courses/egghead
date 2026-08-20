import type { Metadata } from 'next'
import { SubscriptionAdminClient } from '@/app/admin/subscriptions/subscription-admin-client'
import { getSubscriptionProductAdminData } from '@/lib/subscription-products'

export const metadata: Metadata = {
	title: 'Admin - Subscriptions',
	description: 'Manage Egghead subscription products and Stripe prices.',
}

export default async function AdminSubscriptionsPage() {
	const data = await getSubscriptionProductAdminData()

	return (
		<div className="container mx-auto grid max-w-5xl gap-8 px-4 py-8">
			<header className="grid gap-3">
				<p className="text-muted-foreground text-xs font-semibold tracking-[0.18em] uppercase">
					Commerce configuration
				</p>
				<h1 className="text-4xl font-bold tracking-tight">Subscriptions</h1>
				<p className="text-muted-foreground max-w-2xl text-base">
					One control surface for CourseBuilder products, recurring Stripe prices, and merchant
					mappings. Price or interval changes create a new Stripe price and retire the previous
					one.
				</p>
			</header>
			<SubscriptionAdminClient data={data} />
		</div>
	)
}
