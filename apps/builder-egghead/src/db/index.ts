import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { mysqlTable } from '@/db/mysql-table'
import { isLocalDockerDatabase } from '@/db/runtime-guard'
import { env } from '@/env.mjs'
import { Client } from '@planetscale/database'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle as drizzleMySql } from 'drizzle-orm/mysql2'
import { drizzle as drizzlePlanetScale } from 'drizzle-orm/planetscale-serverless'
import type {
	PlanetScalePreparedQueryHKT,
	PlanetscaleQueryResultHKT,
} from 'drizzle-orm/planetscale-serverless/session'
import mysql, { type Pool } from 'mysql2/promise'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

import * as schema from './schema'

type BuilderDatabase = MySqlDatabase<
	PlanetscaleQueryResultHKT,
	PlanetScalePreparedQueryHKT,
	typeof schema
>

type LocalPoolState = {
	databaseUrl: string
	pool: Pool
}

const databaseGlobal = globalThis as typeof globalThis & {
	eggheadBuilderLocalPool?: LocalPoolState
}

function getLocalPool(databaseUrl: string) {
	const current = databaseGlobal.eggheadBuilderLocalPool
	if (current) {
		if (current.databaseUrl !== databaseUrl) {
			throw new Error('Restart the builder after changing its local DATABASE_URL.')
		}
		return current.pool
	}

	const pool = mysql.createPool(databaseUrl)
	databaseGlobal.eggheadBuilderLocalPool = { databaseUrl, pool }
	return pool
}

function createDatabase(): BuilderDatabase {
	const databaseUrl = new URL(env.DATABASE_URL)
	const localDocker = isLocalDockerDatabase({
		host: databaseUrl.hostname,
		database: databaseUrl.pathname.replace(/^\//, ''),
	})
	if (localDocker) {
		const localDatabase = drizzleMySql(getLocalPool(env.DATABASE_URL), {
			mode: 'default',
			schema,
		})
		// Normalize the drivers here so callers keep one usable relational query surface.
		return localDatabase as unknown as BuilderDatabase
	}

	return drizzlePlanetScale(
		new Client({
			url: env.DATABASE_URL,
		}),
		{ schema },
	)
}

export const db = createDatabase()

export async function closeBuilderDatabase() {
	const current = databaseGlobal.eggheadBuilderLocalPool
	if (!current) return

	delete databaseGlobal.eggheadBuilderLocalPool
	await current.pool.end()
}

export const courseBuilderAdapter = DrizzleAdapter<BuilderDatabase>(
	db,
	mysqlTable,
	stripeProvider,
)
