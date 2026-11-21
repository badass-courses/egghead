import { z } from 'zod'

/**
 * Type for position input items used in updateResourcePositions
 */
export type positionInputItem = {
	currentParentResourceId: string
	parentResourceId: string
	resourceId: string
	position: number
	children?: positionInputItem[]
}

/**
 * Server-action input arrives as untrusted JSON, so every position must be a
 * real integer before it reaches either database.
 */
export const PositionInputItemSchema: z.ZodType<positionInputItem> = z.lazy(
	() =>
		z.object({
			currentParentResourceId: z.string(),
			parentResourceId: z.string(),
			resourceId: z.string(),
			position: z.number().int().nonnegative(),
			children: z.array(PositionInputItemSchema).optional(),
		}),
)

export const PositionInputSchema = z.array(PositionInputItemSchema)

/**
 * Builds the parameterized legacy tracklist reorder statement. Values only
 * ever travel as bind parameters, never as SQL text.
 */
export function buildTracklistReorderQuery(item: {
	rowOrder: number
	tracklistableId: unknown
	playlistId: unknown
}): { sql: string; params: unknown[] } {
	return {
		sql: 'UPDATE tracklists SET row_order = $1 WHERE tracklistable_id = $2 AND playlist_id = $3',
		params: [item.rowOrder, item.tracklistableId, item.playlistId],
	}
}
