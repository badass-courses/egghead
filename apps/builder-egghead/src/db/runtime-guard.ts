const DEFAULT_LOCAL_DOCKER_MYSQL_URL =
	"mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const LEADING_SLASH = /^\//;

export type BuilderRuntime = "beta" | "local" | "production";

export type BuilderDatabaseSafety = {
	runtime: BuilderRuntime;
	host: string;
	database: string;
	localDockerOnly: boolean;
	betaDatabaseApproved: boolean;
	betaDatabaseAllowed: boolean;
	productionRuntimeBlocked: boolean;
	writesApproved: false;
};

export function getBuilderRuntime(): BuilderRuntime {
	const rawRuntime = process.env["EGGHEAD_RUNTIME"]?.trim().toLowerCase();

	if (!rawRuntime) return "local";
	if (
		rawRuntime === "local" ||
		rawRuntime === "beta" ||
		rawRuntime === "production"
	) {
		return rawRuntime;
	}

	throw new Error(`Unsupported EGGHEAD_RUNTIME: ${rawRuntime}`);
}

export function isBetaDatabaseApproved(): boolean {
	return (
		process.env["EGGHEAD_BETA_DB_APPROVED"]?.trim().toLowerCase() === "true"
	);
}

function parseDatabaseUrl(rawUrl: string) {
	const url = new URL(rawUrl);
	const host = url.hostname;
	const database = url.pathname.replace(LEADING_SLASH, "");

	return { host, database };
}

export function isLocalDockerDatabase(input: {
	database: string;
	host: string;
}): boolean {
	const { database, host } = input;
	const isLocalHost =
		host === "127.0.0.1" || host === "localhost" || host === "::1";
	const isLocalDatabase =
		database === "coursebuilder_test" ||
		database === "coursebuilder_local" ||
		database.endsWith("_test") ||
		database.endsWith("_local");

	return isLocalHost && isLocalDatabase;
}

export function isPlanetScaleDatabase(input: { host: string }): boolean {
	return (
		input.host.endsWith(".connect.psdb.cloud") ||
		input.host === "aws.connect.psdb.cloud"
	);
}

export function assertBuilderDatabaseUrlForRuntime(
	rawUrl = process.env["DATABASE_URL"] ?? DEFAULT_LOCAL_DOCKER_MYSQL_URL,
): BuilderDatabaseSafety {
	const runtime = getBuilderRuntime();
	const { host, database } = parseDatabaseUrl(rawUrl);
	const localDockerOnly = isLocalDockerDatabase({ database, host });
	const betaDatabaseApproved = isBetaDatabaseApproved();
	const betaDatabaseAllowed =
		runtime === "beta" &&
		betaDatabaseApproved &&
		isPlanetScaleDatabase({ host });
	const productionRuntimeBlocked = runtime === "production";

	if (productionRuntimeBlocked) {
		throw new Error(
			"Refusing production builder runtime before explicit read-flip approval.",
		);
	}

	if (runtime === "local" && !localDockerOnly) {
		throw new Error(
			`Refusing non-local MySQL URL in local builder runtime: host=${host} database=${database}`,
		);
	}

	if (runtime === "beta" && !betaDatabaseAllowed) {
		throw new Error(
			`Refusing beta MySQL URL without approved PlanetScale beta runtime: host=${host} database=${database}`,
		);
	}

	return {
		runtime,
		host,
		database,
		localDockerOnly,
		betaDatabaseApproved,
		betaDatabaseAllowed,
		productionRuntimeBlocked,
		writesApproved: false,
	};
}
