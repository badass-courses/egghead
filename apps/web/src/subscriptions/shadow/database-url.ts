export interface ShadowBranchPins {
  contentReader: string | undefined;
  shadowWriter: string | undefined;
}

function mysqlTarget(raw: string) {
  if (!URL.canParse(raw)) throw new Error("Invalid MySQL database target");
  const url = new URL(raw);
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !url.hostname || !user || !/^[a-z0-9_-]+$/i.test(database)) {
    throw new Error("Invalid MySQL database target");
  }
  return { url, user, database, host: url.hostname.toLowerCase() };
}

/** Pure credential/target validation. Never import the application database client. */
export function shadowDatabaseOptions(
  raw: string,
  appDatabaseUrl?: string,
  pins?: ShadowBranchPins,
) {
  const { url, user, database, host } = mysqlTarget(raw);
  const planetScale = host.endsWith(".connect.psdb.cloud");
  if (appDatabaseUrl) {
    const app = mysqlTarget(appDatabaseUrl);
    if (app.user === user) throw new Error("Shadow refuses application database credentials");
    if (pins && (pins.contentReader !== app.user || pins.shadowWriter !== user)) {
      throw new Error("Shadow branch credential pins do not match");
    }
    // Host aliases and a second password do not establish a different PlanetScale branch.
    // Lockjaw attests each decoded username against PlanetScale branch metadata before binding it.
    if (app.database.toLowerCase() === database.toLowerCase()) {
      if (!planetScale || !app.host.endsWith(".connect.psdb.cloud") || !pins) {
        throw new Error("Shadow requires independently attested branch credentials");
      }
    }
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!planetScale && !(local && database.endsWith("_test")))
    throw new Error("Shadow requires isolated PlanetScale or a local test database");
  // Also refuse the app's unconfigured local fallback, without importing its DB module.
  if (local && database === "coursebuilder_test")
    throw new Error("Shadow refuses the application default database");
  return {
    host,
    port: url.port ? Number(url.port) : 3306,
    user,
    password: decodeURIComponent(url.password),
    database,
    ...(planetScale ? { ssl: { rejectUnauthorized: true } } : {}),
    timezone: "Z",
    connectTimeout: 10_000,
  };
}
