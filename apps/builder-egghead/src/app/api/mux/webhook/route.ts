import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/inngest/inngest.server'
import { verifyMuxSignature } from '@/lib/mux-webhook-signature'
import { withSkill } from '@/server/with-skill'

import {
	MUX_WEBHOOK_EVENT,
	MuxWebhookEventSchema,
} from '@coursebuilder/core/events/video'

export const POST = withSkill(async (req: NextRequest) => {
	// Unsigned or forged events are refused; set MUX_WEBHOOK_SIGNING_SECRET
	// from the Mux dashboard (Settings, Webhooks) for this endpoint.
	const rawBody = await req.text()
	const verified = verifyMuxSignature({
		rawBody,
		header: req.headers.get('mux-signature'),
		secret: process.env.MUX_WEBHOOK_SIGNING_SECRET,
	})
	if (!verified) {
		return new Response('invalid signature', { status: 401 })
	}
	const muxWebhookEvent = MuxWebhookEventSchema.parse(JSON.parse(rawBody))

	console.info(
		`Received from mux: ${muxWebhookEvent.type} [${muxWebhookEvent.object.id}]`,
	)

	await inngest.send({
		name: MUX_WEBHOOK_EVENT,
		data: {
			muxWebhookEvent,
		},
	})

	return new Response('ok', {
		status: 200,
	})
})
