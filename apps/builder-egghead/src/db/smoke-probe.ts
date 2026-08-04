import mysql, { type RowDataPacket } from "mysql2/promise";
import {
	assertBuilderDatabaseUrlForRuntime,
	type BuilderRuntime,
	isPlanetScaleDatabase,
} from "./runtime-guard";

const LEADING_SLASH = /^\//;
const TABLE_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;
const REQUIRED_TABLE_NAMES = [
	"ContentResource",
	"ContentResourceResource",
	"ContentResourceVersion",
	"ContentContribution",
	"User",
	"Account",
	"Session",
];

type SelectOneRow = RowDataPacket & {
	ok: number;
};

type InformationSchemaTableRow = RowDataPacket & {
	TABLE_NAME: string;
	TABLE_ROWS: number | string | null;
};

type CountRow = RowDataPacket & {
	contentResourceCount: number | string;
};

export type BuilderSmokeTableCheck = {
	table: string;
	exists: boolean;
	approxRows: number | null;
};

export type BuilderSmokeProbeResult = {
	host: string;
	database: string;
	runtime: BuilderRuntime;
	readOnlySession: boolean;
	select1: true;
	tables: BuilderSmokeTableCheck[];
	contentResourceCount: number;
};

function safeDecodeURIComponent(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseDatabaseUrl(rawUrl: string) {
	const url = new URL(rawUrl);
	const host = url.hostname;
	const database = url.pathname.replace(LEADING_SLASH, "");

	return { url, host, database };
}

export function mysqlConnectionOptionsFromUrl(rawUrl: string) {
	const { url, host, database } = parseDatabaseUrl(rawUrl);
	const port = Number(url.port || "3306");
	const sslAccept = url.searchParams.get("sslaccept")?.toLowerCase();
	const needsSsl =
		url.searchParams.has("ssl") ||
		sslAccept === "strict" ||
		isPlanetScaleDatabase({ host });

	return {
		host,
		port,
		user: safeDecodeURIComponent(url.username),
		password: safeDecodeURIComponent(url.password),
		database,
		...(needsSsl ? { ssl: { rejectUnauthorized: true } } : {}),
	};
}

function assertValidTablePrefix(tablePrefix: string) {
	if (!TABLE_PREFIX_PATTERN.test(tablePrefix)) {
		throw new Error(
			"Refusing builder smoke probe with invalid table prefix. Only letters, numbers, underscores, and hyphens are allowed.",
		);
	}
}

function tableNameForPrefix(tablePrefix: string, tableName: string) {
	return `${tablePrefix}_${tableName}`;
}

function rowCountApproximation(value: number | string | null): number | null {
	if (value === null) return null;

	const parsed = typeof value === "number" ? value : Number(value);

	return Number.isFinite(parsed) ? parsed : null;
}

function requiredTableNames(tablePrefix: string) {
	return REQUIRED_TABLE_NAMES.map((tableName) =>
		tableNameForPrefix(tablePrefix, tableName),
	);
}

function tablePlaceholders(tableCount: number) {
	return Array.from({ length: tableCount }, () => "?").join(", ");
}

function countFromRow(row: CountRow | undefined) {
	if (row === undefined) {
		throw new Error("ContentResource count query returned no rows.");
	}

	const parsed =
		typeof row.contentResourceCount === "number"
			? row.contentResourceCount
			: Number(row.contentResourceCount);

	if (!Number.isFinite(parsed)) {
		throw new Error("ContentResource count query returned a non-numeric count.");
	}

	return parsed;
}

export async function runBuilderBetaSmokeProbe(options: {
	databaseUrl: string;
	tablePrefix: string;
}): Promise<BuilderSmokeProbeResult> {
	const safety = assertBuilderDatabaseUrlForRuntime(options.databaseUrl);
	assertValidTablePrefix(options.tablePrefix);

	let connection: mysql.Connection | null = null;

	try {
		connection = await mysql.createConnection(
			mysqlConnectionOptionsFromUrl(options.databaseUrl),
		);

		let readOnlySession = false;

		try {
			await connection.query("SET SESSION TRANSACTION READ ONLY");
			readOnlySession = true;
		} catch {
			readOnlySession = false;
		}

		const [selectRows] = await connection.query<SelectOneRow[]>("SELECT 1 AS ok");
		const firstSelectRow = selectRows[0];

		if (firstSelectRow === undefined || firstSelectRow.ok !== 1) {
			throw new Error("Builder smoke probe SELECT 1 failed.");
		}

		const tableNames = requiredTableNames(options.tablePrefix);
		const [informationSchemaRows] = await connection.query<
			InformationSchemaTableRow[]
		>(
			`SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tablePlaceholders(tableNames.length)})`,
			tableNames,
		);
		const rowCountsByTableName = new Map<string, number | null>();

		for (const row of informationSchemaRows) {
			rowCountsByTableName.set(
				row.TABLE_NAME,
				rowCountApproximation(row.TABLE_ROWS),
			);
		}

		const tables = tableNames.map((table) => {
			const approxRows = rowCountsByTableName.get(table);

			return {
				table,
				exists: approxRows !== undefined,
				approxRows: approxRows ?? null,
			};
		});
		const contentResourceTable = tableNameForPrefix(
			options.tablePrefix,
			"ContentResource",
		);
		const contentResourceTableExists = rowCountsByTableName.has(contentResourceTable);
		let contentResourceCount = 0;

		if (contentResourceTableExists) {
			const [countRows] = await connection.query<CountRow[]>(
				`SELECT COUNT(*) AS contentResourceCount FROM \`${contentResourceTable}\``,
			);
			contentResourceCount = countFromRow(countRows[0]);
		}

		return {
			host: safety.host,
			database: safety.database,
			runtime: safety.runtime,
			readOnlySession,
			select1: true,
			tables,
			contentResourceCount,
		};
	} finally {
		await connection?.end().catch(() => undefined);
	}
}
