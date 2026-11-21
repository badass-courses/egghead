import { db } from '@/db'
import { deviceVerifications } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { isAfter } from 'date-fns'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { createTRPCRouter, publicProcedure } from '../trpc'

export const deviceVerificationRouter = createTRPCRouter({
	verify: publicProcedure
		.input(
			z.object({
				userCode: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			const { session } = await getServerAuthSession()


			if (session) {
				const deviceVerification = await db.query.deviceVerifications.findFirst(
					{
						where: eq(deviceVerifications.userCode, input.userCode),
					},
				)


				if (deviceVerification) {
					if (deviceVerification.verifiedAt) {
						return { status: 'already-verified' }
					}

					if (isAfter(new Date(), deviceVerification.expires)) {
						return { status: 'code-expired' }
					}

					if (!session.user) {
						return { status: 'login-required' }
					}

					const verified = await db
						.update(deviceVerifications)
						.set({
							verifiedAt: new Date(),
							verifiedByUserId: session.user.id,
						})
						.where(and(
							eq(deviceVerifications.deviceCode, deviceVerification.deviceCode),
							isNull(deviceVerifications.verifiedAt),
							gt(deviceVerifications.expires, new Date()),
						))

					return { status: verified.rowsAffected === 1 ? 'device-verified' : 'code-expired' }
				} else {
					return { status: 'no-verification-found' }
				}
			} else {
				return { status: 'login-required' }
			}
		}),
})
