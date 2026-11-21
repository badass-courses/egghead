import { headers } from 'next/headers'
import { selfFetchHeaders } from '@/server/self-fetch'

export const dynamic = 'force-dynamic'

export async function GET() {
	const requestHeaders = await headers()
	// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` once CRON_SECRET is
	// set on the project. Without it, refuse: this path is exempt from the proxy.
	const secret = process.env.CRON_SECRET
	if (!secret || requestHeaders.get('authorization') !== `Bearer ${secret}`) {
		return new Response(null, { status: 401 })
	}
	console.log(
		'refreshing inngest',
		await fetch(`${process.env.COURSEBUILDER_URL}/api/inngest`, {
			method: 'PUT',
			headers: selfFetchHeaders(`${process.env.COURSEBUILDER_URL}`),
		}),
	)
	return new Response(null, {
		status: 200,
	})
}
