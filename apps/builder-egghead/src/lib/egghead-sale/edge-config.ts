import { env } from '@/env.mjs'

/**
 * Minimal client for the Vercel Edge Config REST API.
 *
 * egghead-next reads workshop sale state from an Edge Config store
 * (see `src/lib/feature-flags.ts` there). This module lets Builder write
 * the same keys so nobody has to open the Vercel dashboard.
 *
 * Keys follow egghead-next's scheme: `<flagKey>_workshop` (JSON) and
 * `<flagKey>_saleBanner` (boolean).
 */

const VERCEL_API = 'https://api.vercel.com'

export type EdgeConfigItem = {
	key: string
	value: unknown
}

function requireConfig() {
	const token = env.VERCEL_API_TOKEN
	const id = env.EGGHEAD_EDGE_CONFIG_ID
	if (!token || !id) {
		throw new Error(
			'Edge Config is not configured. Set VERCEL_API_TOKEN and EGGHEAD_EDGE_CONFIG_ID.',
		)
	}
	return { token, id, teamId: env.VERCEL_TEAM_ID }
}

function withTeam(url: string, teamId: string | undefined) {
	return teamId ? `${url}?teamId=${encodeURIComponent(teamId)}` : url
}

export function workshopKey(flagKey: string) {
	return `${flagKey}_workshop`
}

export function saleBannerKey(flagKey: string) {
	return `${flagKey}_saleBanner`
}

/**
 * Read every item in the store, keyed by name. The store is small
 * (a handful of flags) so one request is cheaper than one per key.
 */
export async function readAllItems(): Promise<Record<string, unknown>> {
	const { token, id, teamId } = requireConfig()
	const response = await fetch(withTeam(`${VERCEL_API}/v1/edge-config/${id}/items`, teamId), {
		headers: { Authorization: `Bearer ${token}` },
		cache: 'no-store',
	})
	if (!response.ok) {
		throw new Error(
			`Edge Config read failed: ${response.status} ${await response.text()}`,
		)
	}
	const items = (await response.json()) as Array<{ key: string; value: unknown }>
	return Object.fromEntries(items.map((item) => [item.key, item.value]))
}

export async function readItems(keys: string[]): Promise<Record<string, unknown>> {
	const all = await readAllItems()
	return Object.fromEntries(keys.map((key) => [key, all[key]]))
}

/**
 * Upsert several items in one PATCH so related keys change together.
 */
export async function upsertItems(items: EdgeConfigItem[]): Promise<void> {
	const { token, id, teamId } = requireConfig()
	const response = await fetch(withTeam(`${VERCEL_API}/v1/edge-config/${id}/items`, teamId), {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			items: items.map((item) => ({
				operation: 'upsert',
				key: item.key,
				value: item.value,
			})),
		}),
	})
	if (!response.ok) {
		throw new Error(
			`Edge Config write failed: ${response.status} ${await response.text()}`,
		)
	}
}

export function isEdgeConfigConfigured() {
	return Boolean(env.VERCEL_API_TOKEN && env.EGGHEAD_EDGE_CONFIG_ID)
}
