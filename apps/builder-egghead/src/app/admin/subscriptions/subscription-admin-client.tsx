'use client'

import { useActionState } from 'react'
import {
	createSubscriptionProductAction,
	updateSubscriptionProductAction,
	type SubscriptionProductActionState,
} from '@/app/admin/subscriptions/actions'
import type {
	SubscriptionProductAdminData,
	SubscriptionProductAdminItem,
} from '@/lib/subscription-products'
import { AlertCircleIcon, CheckCircle2Icon, PlusIcon, SaveIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@coursebuilder/ui/primitives/alert'
import { Badge } from '@coursebuilder/ui/primitives/badge'
import { Button } from '@coursebuilder/ui/primitives/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@coursebuilder/ui/primitives/card'
import { Input } from '@coursebuilder/ui/primitives/input'
import { Label } from '@coursebuilder/ui/primitives/label'
import { Textarea } from '@coursebuilder/ui/primitives/textarea'

const initialActionState: SubscriptionProductActionState = {
	status: 'idle',
	message: null,
}

function ActionMessage({ state }: { state: SubscriptionProductActionState }) {
	if (!state.message) return null

	return (
		<p
			aria-live="polite"
			className={
				state.status === 'error'
					? 'text-destructive text-sm font-medium'
					: 'text-sm font-medium text-emerald-700 dark:text-emerald-400'
			}
		>
			{state.message}
		</p>
	)
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) {
	return (
		<Label className="text-xs font-semibold tracking-wide uppercase" htmlFor={htmlFor}>
			{children}
		</Label>
	)
}

function ProductFields({
	idPrefix,
	product,
}: {
	idPrefix: string
	product?: SubscriptionProductAdminItem
}) {
	return (
		<div className="grid gap-5">
			<div className="grid gap-2">
				<FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
				<Input
					defaultValue={product?.name ?? 'egghead Annual Membership'}
					id={`${idPrefix}-name`}
					maxLength={90}
					name="name"
					required
				/>
			</div>
			<div className="grid gap-2">
				<FieldLabel htmlFor={`${idPrefix}-description`}>Description</FieldLabel>
				<Textarea
					defaultValue={product?.description ?? 'Annual access to every egghead course and lesson.'}
					id={`${idPrefix}-description`}
					maxLength={500}
					name="description"
					rows={3}
				/>
			</div>
			<div className="grid gap-4 sm:grid-cols-3">
				<div className="grid gap-2">
					<FieldLabel htmlFor={`${idPrefix}-price`}>Price (USD)</FieldLabel>
					<Input
						defaultValue={product?.price ?? 150}
						id={`${idPrefix}-price`}
						min="0.01"
						name="price"
						required
						step="0.01"
						type="number"
					/>
				</div>
				<div className="grid gap-2">
					<FieldLabel htmlFor={`${idPrefix}-interval`}>Interval</FieldLabel>
					<select
						className="border-input bg-background ring-offset-background focus-visible:ring-ring h-10 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
						defaultValue={product?.billingInterval ?? 'year'}
						id={`${idPrefix}-interval`}
						name="billingInterval"
					>
						<option value="month">Monthly</option>
						<option value="year">Yearly</option>
					</select>
				</div>
				<label
					className="border-border bg-muted/30 flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 sm:self-end"
					htmlFor={`${idPrefix}-active`}
				>
					<input
						className="border-input accent-primary h-4 w-4 rounded"
						defaultChecked={product?.active ?? true}
						id={`${idPrefix}-active`}
						name="active"
						type="checkbox"
					/>
					<span className="text-sm font-medium">Active</span>
				</label>
			</div>
		</div>
	)
}

function CreateSubscriptionProduct({ disabled }: { disabled: boolean }) {
	const [state, action, pending] = useActionState(
		createSubscriptionProductAction,
		initialActionState,
	)

	return (
		<Card className="border-dashed">
			<CardHeader>
				<div className="flex items-center gap-3">
					<div className="bg-primary text-primary-foreground grid size-10 place-items-center rounded-full">
						<PlusIcon className="size-5" />
					</div>
					<div>
						<CardTitle>Create subscription product</CardTitle>
						<CardDescription>
							Creates the Stripe product and price plus every CourseBuilder mapping.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<form action={action} className="grid gap-5">
					<fieldset disabled={disabled || pending}>
						<ProductFields idPrefix="new-subscription" />
					</fieldset>
					<div className="flex items-center justify-between gap-4">
						<ActionMessage state={state} />
						<Button disabled={disabled || pending} type="submit">
							<PlusIcon className="mr-2 size-4" />
							{pending ? 'Creating…' : 'Create product'}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	)
}

function SubscriptionProductCard({
	disabled,
	product,
}: {
	disabled: boolean
	product: SubscriptionProductAdminItem
}) {
	const [state, action, pending] = useActionState(
		updateSubscriptionProductAction,
		initialActionState,
	)

	return (
		<Card>
			<CardHeader className="border-border border-b">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="grid gap-2">
						<div className="flex flex-wrap items-center gap-2">
							<CardTitle>{product.name}</CardTitle>
							<Badge variant={product.active ? 'default' : 'secondary'}>
								{product.active ? 'Active' : 'Inactive'}
							</Badge>
							<Badge variant={product.synced ? 'outline' : 'destructive'}>
								{product.synced ? 'Stripe synced' : 'Review sync'}
							</Badge>
						</div>
						<CardDescription className="font-mono text-xs">{product.id}</CardDescription>
					</div>
					<div className="text-muted-foreground grid gap-1 text-right font-mono text-xs">
						<span>{product.stripeProductId ?? 'Missing Stripe product'}</span>
						<span>{product.stripePriceId ?? 'Missing Stripe price'}</span>
					</div>
				</div>
			</CardHeader>
			<CardContent className="pt-6">
				<form action={action} className="grid gap-5">
					<input name="productId" type="hidden" value={product.id} />
					<fieldset disabled={disabled || pending}>
						<ProductFields idPrefix={product.id} product={product} />
					</fieldset>
					<div className="flex items-center justify-between gap-4">
						<ActionMessage state={state} />
						<Button disabled={disabled || pending} type="submit" variant="outline">
							<SaveIcon className="mr-2 size-4" />
							{pending ? 'Saving…' : 'Save changes'}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	)
}

export function SubscriptionAdminClient({ data }: { data: SubscriptionProductAdminData }) {
	return (
		<div className="grid gap-8">
			{data.writesAllowed ? (
				<Alert className="border-emerald-600/30 bg-emerald-500/5">
					<CheckCircle2Icon className="size-4" />
					<AlertTitle>Local Stripe test mode</AlertTitle>
					<AlertDescription>
						Product changes write to local Docker and Stripe test mode only.
					</AlertDescription>
				</Alert>
			) : (
				<Alert variant="destructive">
					<AlertCircleIcon className="size-4" />
					<AlertTitle>Read-only</AlertTitle>
					<AlertDescription>
						{data.writeRestriction ?? 'Subscription product writes are unavailable.'}
					</AlertDescription>
				</Alert>
			)}

			<CreateSubscriptionProduct disabled={!data.writesAllowed} />

			<section aria-labelledby="subscription-products-heading" className="grid gap-4">
				<div className="flex items-end justify-between gap-4">
					<div>
						<h2 className="text-2xl font-semibold" id="subscription-products-heading">
							Subscription products
						</h2>
						<p className="text-muted-foreground text-sm">
							{data.products.length} configured · Stripe {data.stripeMode} mode
						</p>
					</div>
				</div>
				{data.products.length ? (
					<div className="grid gap-5">
						{data.products.map((product) => (
							<SubscriptionProductCard
								disabled={!data.writesAllowed}
								key={product.id}
								product={product}
							/>
						))}
					</div>
				) : (
					<Card>
						<CardContent className="text-muted-foreground py-12 text-center">
							No membership products are configured yet.
						</CardContent>
					</Card>
				)}
			</section>
		</div>
	)
}
