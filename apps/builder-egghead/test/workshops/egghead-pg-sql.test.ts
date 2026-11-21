import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
	buildTracklistReorderQuery,
	PositionInputSchema,
} from '../../src/lib/posts/position-input'

const injection = '0; DROP TABLE tracklists; --'

describe('legacy egghead Postgres queries', () => {
	it('rejects a non-integer position before any query is built', () => {
		const item = {
			currentParentResourceId: 'course-1',
			parentResourceId: 'course-1',
			resourceId: 'lesson-1',
			position: injection,
		}
		expect(PositionInputSchema.safeParse([item]).success).toBe(false)
		expect(
			PositionInputSchema.safeParse([
				{ ...item, position: 1, children: [{ ...item, position: 1.5 }] },
			]).success,
		).toBe(false)
		expect(PositionInputSchema.safeParse([{ ...item, position: 2 }]).success).toBe(
			true,
		)
	})

	it('keeps hostile values out of the tracklist SQL text', () => {
		const benign = buildTracklistReorderQuery({
			rowOrder: 1,
			tracklistableId: 2,
			playlistId: 3,
		})
		const hostile = buildTracklistReorderQuery({
			rowOrder: injection as unknown as number,
			tracklistableId: injection,
			playlistId: injection,
		})
		expect(hostile.sql).toBe(benign.sql)
		expect(hostile.sql).not.toContain('DROP')
		expect(hostile.params).toEqual([injection, injection, injection])
	})

	it('never interpolates values into eggheadPgQuery SQL', () => {
		const src = fileURLToPath(new URL('../../src', import.meta.url))
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name)
				if (statSync(path).isDirectory()) walk(path)
				else if (/\.(ts|tsx)$/.test(name)) files.push(path)
			}
		}
		walk(src)

		const offenders: string[] = []
		// A template literal passed straight to eggheadPgQuery may only use
		// ${...} to build a placeholder like $${n}, never to splice a value.
		const call = /eggheadPgQuery\(\s*`([^`]*)`/g
		for (const file of files) {
			const text = readFileSync(file, 'utf8')
			for (const match of text.matchAll(call)) {
				const sql = match[1] ?? ''
				const spliced = sql
					.replace(/\$\$\{[^}]*\}/g, '')
					.replace(/\$\{updateFields\.join\(', '\)\}/g, '')
				if (spliced.includes('${')) offenders.push(file.slice(src.length))
			}
		}
		expect(offenders).toEqual([])
	})

	it('never splices values into SQL in any module that talks to the egghead pool', () => {
		const src = fileURLToPath(new URL('../../src', import.meta.url))
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name)
				if (statSync(path).isDirectory()) walk(path)
				else if (/\.(ts|tsx)$/.test(name)) files.push(path)
			}
		}
		walk(src)

		// Covers eggheadPgQuery, pool.query and client.query alike, including SQL
		// built in a helper and passed by variable: any template literal that reads
		// as SQL in a file importing the egghead pool may not splice a value.
		const sqlVerb = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|SELECT\b[\s\S]*\bFROM)\b/i
		const template = /`([^`]*)`/g
		const offenders: string[] = []
		for (const file of files) {
			const text = readFileSync(file, 'utf8')
			if (!/eggheadPostgres/.test(text)) continue
			for (const match of text.matchAll(template)) {
				const body = match[1] ?? ''
				if (!sqlVerb.test(body)) continue
				// Allowed structural splices only: $${n} placeholders, a joined list of
				// `$n` placeholders, and column lists from constant arrays in the same
				// module (INSERT helpers in course.ts, instructor.ts, lesson.ts) or
				// updateTag's zod-fixed keys.
				const spliced = body
					.replace(/\$\$\{[^}]*\}/g, '')
					.replace(/\$\{updateFields\.join\(', '\)\}/g, '')
					.replace(/\$\{columns\.join\(', '\)\}/g, '')
					.replace(/\$\{placeholders\}/g, '')
				if (spliced.includes('${')) offenders.push(file.slice(src.length))
			}
		}
		expect(offenders).toEqual([])
	})
})
