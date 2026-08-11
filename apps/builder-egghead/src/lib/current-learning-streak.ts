import 'server-only'

import { db } from '@/db'
import { contentResource, resourceProgress } from '@/db/schema'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const CompletionDayRowsSchema = z.array(
	z.object({
		completionDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	}),
)

function utcDayNumber(date: Date) {
	return Math.floor(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
			MILLISECONDS_PER_DAY,
	)
}

function utcDayNumberFromIsoDate(value: string) {
	const timestamp = Date.parse(`${value}T00:00:00.000Z`)
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
		return null
	}

	return Math.floor(timestamp / MILLISECONDS_PER_DAY)
}

function currentStreakDays(completionDays: readonly string[], today = new Date()) {
	const todayNumber = utcDayNumber(today)
	const completedDayNumbers = new Set<number>()

	for (const completionDay of completionDays) {
		const dayNumber = utcDayNumberFromIsoDate(completionDay)
		if (dayNumber !== null && dayNumber <= todayNumber) completedDayNumbers.add(dayNumber)
	}

	let cursor = completedDayNumbers.has(todayNumber)
		? todayNumber
		: completedDayNumbers.has(todayNumber - 1)
			? todayNumber - 1
			: null
	let streak = 0

	while (cursor !== null && completedDayNumbers.has(cursor)) {
		streak += 1
		cursor -= 1
	}

	return streak
}

export async function getCurrentLearningStreakDays(userId: string) {
	const result = await db.execute(sql`
		SELECT DISTINCT DATE_FORMAT(progress.completedAt, '%Y-%m-%d') AS completionDay
		FROM ${resourceProgress} progress
		JOIN ${contentResource} resource
			ON resource.id = progress.resourceId
			AND resource.deletedAt IS NULL
		WHERE progress.userId = ${userId}
			AND progress.completedAt IS NOT NULL
			AND CAST(
				CASE
					WHEN JSON_TYPE(JSON_EXTRACT(resource.fields, '$.postType')) = 'STRING'
						AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))) NOT IN ('', 'null')
					THEN TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))
					ELSE resource.type
				END AS BINARY
			) IN (CAST('lesson' AS BINARY), CAST('course' AS BINARY))
			AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.state')), 'published')) = 'published'
			AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.visibility')), 'public'))
				NOT IN ('archived', 'deleted', 'draft', 'private', 'trash', 'trashed', 'unpublished')
			AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.visibilityState')), 'public'))
				NOT IN ('archived', 'deleted', 'draft', 'private', 'trash', 'trashed', 'unpublished')
		ORDER BY completionDay DESC
	`)
	const rows = CompletionDayRowsSchema.parse(result.rows)

	return currentStreakDays(rows.map((row) => row.completionDay))
}
