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

	const pairs = header.split(',').map((part) => {
		const [k, ...v] = part.trim().split('=')
		return [k, v.join('=')] as const
	})
	const t = pairs.find(([k]) => k === 't')?.[1]
	const timestamp = Number(t)
	// Mux may send several v1 values while a secret rotates; any match counts.
	const signatures = pairs
		.filter(([k, v]) => k === 'v1' && /^[0-9a-f]+$/i.test(v))
		.map(([, v]) => v)
	if (!t || !Number.isFinite(timestamp) || signatures.length === 0) return false

	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - timestamp) > (params.toleranceSeconds ?? 300)) return false

	const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
	return signatures.some((signature) => {
		const given = Buffer.from(signature, 'hex')
		return given.length === expected.length && timingSafeEqual(given, expected)
	})
}
