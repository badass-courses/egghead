import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { accountRowMatch } from '@/server/auth-account-tokens'
import egghead from '@/server/egghead-auth-provider'

/**
 * The builder's signIn event refreshes OAuth tokens on the Account row.
 * Auth.js stores `account.provider` as the provider id, so the refresh must
 * match that stored value plus the provider account id, and nothing else.
 */
const mysqlUrl = process.env['AUTH_LINKING_MYSQL_URL']

async function loadAccounts() {
	vi.stubEnv('NEXT_PUBLIC_APP_NAME', 'egghead')
	const schema = await import('@/db/schema')
	return schema.accounts
}

function eggheadRowMatch(
	accounts: Awaited<ReturnType<typeof loadAccounts>>,
	providerAccountId: string,
) {
	const provider = egghead({ clientId: 'test', clientSecret: 'test' })
	const where = accountRowMatch(accounts, { provider: provider.id, providerAccountId })
	if (!where) throw new Error('accountRowMatch built no condition')
	return where
}

describe('builder account token refresh', () => {
	let accounts: Awaited<ReturnType<typeof loadAccounts>>

	beforeAll(async () => {
		accounts = await loadAccounts()
	})

	it('matches the stored provider id and the provider account id', () => {
		const query = new MySqlDialect().sqlToQuery(eggheadRowMatch(accounts, '42'))

		expect(egghead({ clientId: 'test', clientSecret: 'test' }).id).toBe('egghead')
		expect(query.sql).toBe(
			'(`egghead_Account`.`provider` = ? and `egghead_Account`.`providerAccountId` = ?)',
		)
		expect(query.params).toEqual(['egghead', '42'])
	})

	it.skipIf(!mysqlUrl)(
		'updates only the egghead row when a github row shares the account id',
		async () => {
			const url = new URL(mysqlUrl ?? '')
			if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
				throw new Error('Refusing a non-local MySQL for the token refresh test')
			}
			if (!url.pathname.endsWith('_test')) {
				throw new Error(
					'Refusing a non-disposable database for the token refresh test',
				)
			}
			const connection = await mysql.createConnection(mysqlUrl ?? '')
			const db = drizzle(connection)

			try {
				await db.delete(accounts).where(eq(accounts.providerAccountId, '42'))
				await db.insert(accounts).values([
					{
						userId: randomUUID(),
						type: 'oauth',
						provider: 'egghead',
						providerAccountId: '42',
						access_token: 'old-egghead-token',
					},
					{
						userId: randomUUID(),
						type: 'oauth',
						provider: 'github',
						providerAccountId: '42',
						access_token: 'github-token',
					},
				])

				await db
					.update(accounts)
					.set({ access_token: 'fresh-egghead-token', expires_at: 1_900_000_000 })
					.where(eggheadRowMatch(accounts, '42'))

				const rows = await db
					.select({ provider: accounts.provider, accessToken: accounts.access_token })
					.from(accounts)
					.where(eq(accounts.providerAccountId, '42'))
				expect(
					Object.fromEntries(rows.map((row) => [row.provider, row.accessToken])),
				).toEqual({ egghead: 'fresh-egghead-token', github: 'github-token' })
			} finally {
				await db.delete(accounts).where(eq(accounts.providerAccountId, '42'))
				await connection.end()
			}
		},
	)
})
