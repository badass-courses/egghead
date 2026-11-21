import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Mux webhook `mux-signature` header (`t=<unix seconds>,v1=<hex>`):
 * HMAC-SHA256 of `${t}.${rawBody}` with the webhook signing secret, within a
 * tolerance window so a captured request can't be replayed later.
 * See https://docs.mux.com/guides/listen-for-webhooks#verify-webhook-signatures
 */
export function verifyMuxSignature(params: {
	rawBody: string
	header: string | null
	secret: string | undefined
	nowSeconds?: number
	toleranceSeconds?: number
}): boolean {
	const { rawBody, header, secret } = params
	if (!secret || !header) return false

	const parts = Object.fromEntries(
		header.split(',').map((part) => {
			const [k, ...v] = part.trim().split('=')
			return [k, v.join('=')]
		}),
	)
	const timestamp = Number(parts.t)
	const signature = parts.v1
	if (!Number.isFinite(timestamp) || !signature || !/^[0-9a-f]+$/i.test(signature)) return false

	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - timestamp) > (params.toleranceSeconds ?? 300)) return false

	const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest()
	const given = Buffer.from(signature, 'hex')
	return given.length === expected.length && timingSafeEqual(given, expected)
}
