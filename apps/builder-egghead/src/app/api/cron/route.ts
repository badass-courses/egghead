import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function GET() {
	const requestHeaders = await headers()
	// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the secret is set.
	const secret = process.env.CRON_SECRET
	if (secret && requestHeaders.get('authorization') !== `Bearer ${secret}`) {
		return new Response(null, { status: 401 })
	}
	console.log(
		'refreshing inngest',
		await fetch(`${process.env.COURSEBUILDER_URL}/api/inngest`, {
			method: 'PUT',
		}),
	)
	return new Response(null, {
		status: 200,
	})
}
