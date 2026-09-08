import { z } from 'zod'

import type { EggheadSale, Event } from '@/lib/events'

/**
 * Mirror of `LiveWorkshopSchema` in egghead-next `src/types.ts`.
 * The live site validates the Edge Config JSON against that schema at read
 * time (`trpc.featureFlag.getLiveWorkshop` uses `.parse()`), so a mismatch
 * here would 500 the workshop page. Keep the two in sync until cutover.
 */
export const LiveWorkshopSchema = z.object({
	date: z.string(),
	startTime: z.string(),
	timeZone: z.string(),
	utcOffset: z.string(),
	endTime: z.string(),
	isSaleLive: z.boolean(),
	isEuFriendly: z.boolean(),
	isEarlyBird: z.boolean(),
	earlyBirdEndDate: z.string().optional(),
	productId: z.string(),
	workshopPrice: z.string(),
	stripePaymentLink: z.string(),
	stripeEarlyBirdMemberCouponCode: z.string(),
	stripeMemberCouponCode: z.string(),
	stripeEarlyBirdCouponCode: z.string(),
	stripeEarlyBirdMemberDiscount: z.string(),
	stripeMemberDiscount: z.string(),
	stripeEarlyBirdNonMemberDiscount: z.string(),
	bannerMessage: z.string().optional(),
	earlyBirdBannerMessage: z.string().optional(),
})

export type LiveWorkshop = z.infer<typeof LiveWorkshopSchema>

const TIMEZONE_LABELS: Record<string, string> = {
	'America/Los_Angeles': 'PT',
	'America/Denver': 'MT',
	'America/Chicago': 'CT',
	'America/New_York': 'ET',
	'Europe/London': 'UK',
	UTC: 'UTC',
}

function partsFor(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
	const formatter = new Intl.DateTimeFormat('en-US', { timeZone, ...options })
	return Object.fromEntries(
		formatter.formatToParts(date).map((part) => [part.type, part.value]),
	)
}

/** `2026-09-18` in the event timezone — the form the current Software Factory config uses. */
export function formatWorkshopDate(date: Date, timeZone: string) {
	const parts = partsFor(date, timeZone, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	})
	return `${parts.year}-${parts.month}-${parts.day}`
}

/** `09-18` — used in coupon names. */
export function formatMonthDay(date: Date, timeZone: string) {
	const parts = partsFor(date, timeZone, { month: '2-digit', day: '2-digit' })
	return `${parts.month}-${parts.day}`
}

/** `9:00 AM` — matches `/(\d{1,2}):(\d{2})\s*(AM|PM)/` on the live site. */
export function formatWorkshopTime(date: Date, timeZone: string) {
	const parts = partsFor(date, timeZone, {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	})
	return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}

/** `UTC-7` — matches `/UTC([+-])(\d{1,2})/` on the live site. Whole hours only. */
export function formatUtcOffset(date: Date, timeZone: string) {
	const parts = partsFor(date, timeZone, { timeZoneName: 'longOffset' })
	const raw = parts.timeZoneName ?? 'GMT'
	if (raw === 'GMT') return 'UTC+0'
	const match = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
	if (!match) return 'UTC+0'
	return `UTC${match[1]}${Number(match[2])}`
}

export function timeZoneLabel(timeZone: string) {
	return TIMEZONE_LABELS[timeZone] ?? timeZone
}

export type LiveWorkshopInput = {
	event: Event
	sale: EggheadSale
	isSaleLive: boolean
	workshopPrice: number
}

/**
 * Build the JSON egghead-next expects for `<flagKey>_workshop`.
 * Throws when the event has no schedule, because the page cannot render without one.
 */
export function buildLiveWorkshop({
	event,
	sale,
	isSaleLive,
	workshopPrice,
}: LiveWorkshopInput): LiveWorkshop {
	const { startsAt, endsAt } = event.fields
	if (!startsAt || !endsAt) {
		throw new Error(
			`Event ${event.fields.slug} needs both startsAt and endsAt before it can go on sale.`,
		)
	}
	const timeZone = event.fields.timezone || 'America/Los_Angeles'
	const start = new Date(startsAt)
	const end = new Date(endsAt)

	const candidate: LiveWorkshop = {
		date: formatWorkshopDate(start, timeZone),
		startTime: formatWorkshopTime(start, timeZone),
		endTime: formatWorkshopTime(end, timeZone),
		timeZone: timeZoneLabel(timeZone),
		utcOffset: formatUtcOffset(start, timeZone),
		isSaleLive,
		isEuFriendly: sale.isEuFriendly,
		isEarlyBird: Boolean(sale.earlyBirdEndDate),
		earlyBirdEndDate: sale.earlyBirdEndDate ?? undefined,
		productId: sale.stripeProductId,
		workshopPrice: String(workshopPrice),
		stripePaymentLink: sale.paymentLinkUrl,
		stripeMemberCouponCode: sale.promoCodes.member.code,
		stripeEarlyBirdCouponCode: sale.promoCodes.earlyBird.code,
		stripeEarlyBirdMemberCouponCode: sale.promoCodes.earlyBirdMember.code,
		stripeMemberDiscount: String(sale.promoCodes.member.amountOff),
		stripeEarlyBirdNonMemberDiscount: String(sale.promoCodes.earlyBird.amountOff),
		stripeEarlyBirdMemberDiscount: String(sale.promoCodes.earlyBirdMember.amountOff),
		bannerMessage: sale.bannerMessage ?? undefined,
		earlyBirdBannerMessage: sale.earlyBirdBannerMessage ?? undefined,
	}

	return LiveWorkshopSchema.parse(candidate)
}
