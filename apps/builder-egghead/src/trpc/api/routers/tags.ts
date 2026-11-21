import { EggheadTagFieldsSchema } from '@/lib/tags'
import { createTag, getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const tagsRouter = createTRPCRouter({
	getTags: publicProcedure.query(async () => {
		return getTags()
	}),

	createTag: publicProcedure
		.input(
			z.object({
				type: z.literal('topic'),
				fields: EggheadTagFieldsSchema,
			}),
		)
		.mutation(async ({ input }) => {
			const { session, ability } = await getServerAuthSession()
			if (!session?.user?.id || ability.cannot('create', 'Content')) {
				throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Contributors only' })
			}
			return createTag(input)
		}),
})
