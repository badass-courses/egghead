import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
	buildWorkshopConfig,
	checkDrift,
	type DriftReport,
} from '@/lib/egghead-sale/publish'
import { readStripeSaleState, resolveCommerceForEvent } from '@/lib/egghead-sale/stripe'
import { getEvent } from '@/lib/events-query'
import { getServerAuthSession } from '@/server/auth'

import { Button } from '@coursebuilder/ui'

import { endSaleAction, goLiveAction } from './actions'

export const dynamic = 'force-dynamic'

interface EggheadSalePageProps {
	params: Promise<{ slug: string }>
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<tr className="border-b">
			<th className="w-56 py-2 pr-4 text-left align-top text-sm font-medium text-muted-foreground">
				{label}
			</th>
			<td className="py-2 font-mono text-sm break-all">{value}</td>
		</tr>
	)
}

function DriftTable({ report }: { report: DriftReport }) {
	if (report.ok) {
		return (
			<p className="rounded border border-green-700/40 bg-green-700/10 px-3 py-2 text-sm">
				Builder, Stripe, and Edge Config agree. Checked {report.checkedAt}.
			</p>
		)
	}
	return (
		<div className="rounded border border-red-700/40 bg-red-700/10 p-3">
			<p className="mb-2 text-sm font-medium">
				{report.mismatches.length} mismatch{report.mismatches.length === 1 ? '' : 'es'}
			</p>
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-muted-foreground">
						<th className="py-1 pr-3">Field</th>
						<th className="py-1 pr-3">Builder</th>
						<th className="py-1 pr-3">Stripe</th>
						<th className="py-1">Edge Config</th>
					</tr>
				</thead>
				<tbody>
					{report.mismatches.map((mismatch) => (
						<tr key={mismatch.field} className="border-t font-mono">
							<td className="py-1 pr-3">{mismatch.field}</td>
							<td className="py-1 pr-3">{JSON.stringify(mismatch.builder)}</td>
							<td className="py-1 pr-3">
								{mismatch.stripe === undefined ? '' : JSON.stringify(mismatch.stripe)}
							</td>
							<td className="py-1">
								{mismatch.edgeConfig === undefined ? '' : JSON.stringify(mismatch.edgeConfig)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

export default async function EggheadSalePage({ params }: EggheadSalePageProps) {
	const { slug } = await params
	const { ability } = await getServerAuthSession()
	if (!ability.can('manage', 'Content')) {
		redirect('/')
	}

	const event = await getEvent(slug)
	if (!event) {
		notFound()
	}

	const sale = event.fields.eggheadSale

	if (!sale) {
		return (
			<div className="max-w-3xl">
				<h1 className="mb-2 text-3xl font-bold">egghead.io sale</h1>
				<p className="mb-6 text-muted-foreground">{event.fields.title}</p>
				<p className="mb-4">
					This event has no egghead.io sale yet. From Claude Code, run{' '}
					<code>create_sale</code> for <code>{event.fields.slug}</code>, then come back here.
				</p>
				<Link href={`/admin/events/${event.fields.slug}/edit`} className="underline">
					Back to edit
				</Link>
			</div>
		)
	}

	const [commerce, stripeState, config, drift] = await Promise.all([
		resolveCommerceForEvent(event).catch((error: Error) => ({ error: error.message })),
		readStripeSaleState(sale).catch((error: Error) => ({ error: error.message })),
		buildWorkshopConfig(event).catch((error: Error) => ({ error: error.message })),
		checkDrift(event).catch(
			(error: Error): DriftReport => ({
				ok: false,
				checkedAt: new Date().toISOString(),
				mismatches: [{ field: 'check', builder: error.message }],
				notes: [],
			}),
		),
	])

	const edge = 'error' in config ? null : config.current
	const isLive = edge?.workshop?.isSaleLive ?? false

	return (
		<div className="max-w-3xl space-y-8">
			<div>
				<h1 className="mb-1 text-3xl font-bold">egghead.io sale</h1>
				<p className="text-muted-foreground">
					{event.fields.title} ·{' '}
					<Link href={`/admin/events/${event.fields.slug}/edit`} className="underline">
						edit event
					</Link>
				</p>
			</div>

			<section className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					<span
						className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
							isLive ? 'bg-green-700/15 text-green-800' : 'bg-amber-700/15 text-amber-800'
						}`}
					>
						{edge?.configured === false ? 'Edge Config not configured' : isLive ? 'On sale' : 'Not on sale'}
					</span>
					{sale.approvedBy && (
						<span className="text-sm text-muted-foreground">
							Approved by {sale.approvedBy} at {sale.approvedAt}
						</span>
					)}
				</div>
				<div className="flex gap-3">
					<form action={goLiveAction}>
						<input type="hidden" name="slug" value={event.fields.slug} />
						<Button type="submit" disabled={isLive || !drift.ok || edge?.configured === false}>
							Go live
						</Button>
					</form>
					<form action={endSaleAction}>
						<input type="hidden" name="slug" value={event.fields.slug} />
						<Button type="submit" variant="outline" disabled={!isLive}>
							End sale
						</Button>
					</form>
				</div>
				{!drift.ok && (
					<p className="text-sm text-muted-foreground">
						Go live is disabled until the drift below is resolved.
					</p>
				)}
			</section>

			<section>
				<h2 className="mb-2 text-xl font-semibold">Drift</h2>
				<DriftTable report={drift} />
				{drift.notes.map((note) => (
					<p key={note} className="mt-2 text-sm text-muted-foreground">
						{note}
					</p>
				))}
			</section>

			<section>
				<h2 className="mb-2 text-xl font-semibold">Builder</h2>
				<table className="w-full">
					<tbody>
						<Row label="Slug" value={event.fields.slug} />
						<Row label="Starts" value={event.fields.startsAt ?? ''} />
						<Row label="Ends" value={event.fields.endsAt ?? ''} />
						<Row label="Timezone" value={event.fields.timezone ?? ''} />
						<Row label="State / visibility" value={`${event.fields.state} / ${event.fields.visibility}`} />
						<Row label="Flag key" value={sale.flagKey} />
						<Row
							label="Commerce"
							value={'error' in commerce ? commerce.error : `${commerce.productId} · $${commerce.price} · seats ${commerce.quantityAvailable}`}
						/>
					</tbody>
				</table>
			</section>

			<section>
				<h2 className="mb-2 text-xl font-semibold">Stripe</h2>
				{'error' in stripeState ? (
					<p className="text-sm text-red-700">{stripeState.error}</p>
				) : (
					<table className="w-full">
						<tbody>
							<Row
								label="Product"
								value={stripeState.product ? `${stripeState.product.id} · ${stripeState.product.name}${stripeState.product.active ? '' : ' · inactive'}` : 'missing'}
							/>
							<Row
								label="Price"
								value={stripeState.price ? `${stripeState.price.id} · $${stripeState.price.unitAmount ?? '?'}${stripeState.price.active ? '' : ' · inactive'}` : 'missing'}
							/>
							<Row
								label="Payment Link"
								value={
									stripeState.paymentLink ? (
										<a href={stripeState.paymentLink.url} className="underline" target="_blank" rel="noreferrer">
											{stripeState.paymentLink.url}
										</a>
									) : (
										'missing'
									)
								}
							/>
							{stripeState.promoCodes.map((code) => (
								<Row
									key={code.id}
									label={`Promo · ${code.role}`}
									value={`${code.code} · $${code.amountOff ?? '?'} off${code.expiresAt ? ` · expires ${code.expiresAt}` : ''}${code.active ? '' : ' · inactive'}`}
								/>
							))}
						</tbody>
					</table>
				)}
			</section>

			<section>
				<h2 className="mb-2 text-xl font-semibold">What egghead.io will read</h2>
				{'error' in config ? (
					<p className="text-sm text-red-700">{config.error}</p>
				) : (
					<>
						<p className="mb-2 text-sm text-muted-foreground">
							Key <code>{config.flagKey}_workshop</code>. Currently in Edge Config:{' '}
							{edge?.configured ? (edge.workshopValid ? 'valid' : edge.workshopRaw === null ? 'missing' : 'invalid') : 'not configured here'}
							, banner flag {edge?.saleBanner === null ? 'unset' : String(edge?.saleBanner)}.
						</p>
						<pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
							{JSON.stringify(config.workshop, null, 2)}
						</pre>
					</>
				)}
			</section>
		</div>
	)
}
