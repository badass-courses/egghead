import { and, eq } from 'drizzle-orm'
import type { MySqlColumn } from 'drizzle-orm/mysql-core'

/**
 * Match exactly one Account row: the stored provider id plus the provider's
 * account id. Matching on the account id alone would also hit another
 * provider's row with the same numeric id.
 */
export function accountRowMatch(
	columns: { provider: MySqlColumn; providerAccountId: MySqlColumn },
	account: { provider: string; providerAccountId: string },
) {
	return and(
		eq(columns.provider, account.provider),
		eq(columns.providerAccountId, account.providerAccountId),
	)
}
