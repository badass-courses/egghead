import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every 'use server' export that a 'use client' file imports gets a Next
 * action id, and Next dispatches actions by id whatever the URL path, so the
 * proxy can't gate them. Each such export must check its caller before it
 * touches data (sec-20261121-008).
 */
const root = fileURLToPath(new URL('../../src/', import.meta.url))

// Exports that are intentionally callable without an editor session.
const PUBLIC_ACTIONS = new Set([
	// Invitees have no account yet; the action checks the invite itself.
	'app/(user)/invites/[inviteId]/actions.ts#acceptInstructorInvite',
	'app/(user)/invites/[inviteId]/onboarding/actions.ts#createInstructorProfile',
	// No data access: logs or redirects only.
	'app/(content)/posts/[slug]/edit/actions.ts#onPostPublish',
	'app/(content)/prompts/[slug]/edit/actions.ts#onPromptSave',
	// Latent: reached only through barrel modules (lib/egghead, lib/posts) that a
	// client file imports for constants and types; no client code calls them.
	// They also run for device-token API routes and Inngest, which have no
	// session, so the fix is moving them into server-only modules (follow-up).
	'lib/posts/read.ts#getAllPostIds',
	'lib/posts/read.ts#getPost',
	'lib/posts/write.ts#writePostUpdateToDatabase',
	'lib/egghead/tags.ts#writeLegacyTaggingsToEgghead',
])

const files: string[] = []
const walk = (dir: string) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) walk(path)
		else if (/\.(ts|tsx)$/.test(name)) files.push(path)
	}
}
walk(root)
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const isServer = (t: string) => /^\s*['"]use server['"]/.test(t)
const isClient = (t: string) => /^\s*['"]use client['"]/.test(t)

const resolveImport = (from: string, spec: string): string | null => {
	const base = spec.startsWith('@/') ? join(root, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null
	if (!base) return null
	for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (text.has(c)) return c
	return null
}

const exportsOf = (file: string, seen = new Set<string>()): Record<string, string> => {
	if (seen.has(file)) return {}
	seen.add(file)
	const t = text.get(file) ?? ''
	const out: Record<string, string> = {}
	for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)) out[m[1]!] = file
	for (const m of t.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
		const target = resolveImport(file, m[2]!)
		if (!target) continue
		const inner = exportsOf(target, seen)
		for (const part of m[1]!.split(',')) {
			const [orig, alias] = part.trim().split(/\s+as\s+/)
			if (orig && inner[orig]) out[(alias ?? orig).trim()] = inner[orig]!
		}
	}
	// Barrels that import then re-export: `import { a } from './x'` + `export { a }`.
	for (const m of t.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
		const target = resolveImport(file, m[2]!)
		if (!target) continue
		const inner = exportsOf(target, new Set(seen))
		for (const part of m[1]!.split(',')) {
			const name = part.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')
			if (inner[name] && new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(t)) out[name] = inner[name]!
		}
	}
	for (const m of t.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
		const target = resolveImport(file, m[1]!)
		if (target) Object.assign(out, exportsOf(target, seen))
	}
	return out
}

// The client module graph: 'use client' files and everything they import,
// stopping at 'use server' modules (those become action references).
const clientGraph = new Set<string>()
const queue = [...text.keys()].filter((f) => isClient(text.get(f) ?? ''))
while (queue.length) {
	const file = queue.pop()!
	if (clientGraph.has(file)) continue
	clientGraph.add(file)
	for (const m of (text.get(file) ?? '').matchAll(/(?:^|\n)\s*(import|export)(\s+type\b)?([^'";]*?)from\s*['"]([^'"]+)['"]/g)) {
		// Type-only imports carry no runtime code: `import type {…}` or `{ type A }`.
		if (m[2]) continue
		const braces = m[3]!.match(/\{([^}]*)\}/)?.[1]
		const specifiers = braces?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
		const hasDefaultOrStar = /^\s*[\w*]/.test(m[3]!.replace(/\{[^}]*\}/, '').replace(/,/g, ''))
		if (specifiers.length && !hasDefaultOrStar && specifiers.every((s) => s.startsWith('type '))) continue
		const target = resolveImport(file, m[4]!)
		const targetText = text.get(target ?? '') ?? ''
		// 'use server' modules become action references; 'server-only' modules
		// can't be bundled for the client at all.
		if (target && !isServer(targetText) && !/import ['"]server-only['"]/.test(targetText)) {
			queue.push(target)
		}
	}
}

const clientReferenced = new Set<string>()
for (const file of clientGraph) {
	const t = text.get(file) ?? ''
	for (const m of t.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
		const target = resolveImport(file, m[2]!)
		if (!target) continue
		const ex = exportsOf(target)
		for (const part of m[1]!.split(',')) {
			const name = part.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')
			const def = ex[name]
			if (def && isServer(text.get(def) ?? '')) clientReferenced.add(`${relative(root, def)}#${name}`)
		}
	}
}

const bodyOf = (t: string, name: string) => {
	const start = t.search(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`))
	const rest = t.slice(start + 1)
	const next = rest.search(/\nexport /)
	return t.slice(start, next < 0 ? undefined : start + 1 + next)
}

const GUARD = /requireCanManageResource\(|requireContentEditor\(|requireAdmin\(|getServerAuthSession\(/
const DATA = /\b(db|trx|courseBuilderAdapter)\.|eggheadPgQuery\(|inngest\.send\(|fetch\(|revalidate(Path|Tag)\(/

describe('client-referenced server actions check their caller', () => {
	it('finds the known actions (inventory sanity)', () => {
		expect(clientReferenced.size).toBeGreaterThan(10)
		expect(clientReferenced.has('lib/posts/write.ts#addTagToPost')).toBe(true)
		expect(clientReferenced.has('lib/posts/write.ts#setPrimaryTagToPost')).toBe(true)
	})

	it('every one guards before its first data call, unless listed as public', () => {
		const unguarded: string[] = []
		for (const key of clientReferenced) {
			if (PUBLIC_ACTIONS.has(key)) continue
			const [rel, name] = key.split('#') as [string, string]
			const body = bodyOf(text.get(join(root, rel)) ?? '', name)
			const guard = body.search(GUARD)
			const data = body.search(DATA)
			if (guard === -1 || (data !== -1 && data < guard)) unguarded.push(key)
		}
		expect(unguarded).toEqual([])
	})
})
