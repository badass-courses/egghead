/** Pure credential/target validation. Never import the application database client. */
export function shadowDatabaseOptions(raw: string, appDatabaseUrl?: string) {
  const url = new URL(raw);
  if (url.protocol !== "mysql:" || !url.username || !url.pathname.slice(1))
    throw new Error("Shadow requires a dedicated MySQL database");
  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username);
  if (appDatabaseUrl) {
    const app = new URL(appDatabaseUrl);
    // PlanetScale branches share a hostname/database name; the branch user is the boundary.
    // Passwords, URL encoding, query options and the selected database cannot evade this check.
    if (app.hostname.toLowerCase() === host && decodeURIComponent(app.username) === user)
      throw new Error("Shadow refuses application database credentials");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const planetScale = host.endsWith(".connect.psdb.cloud");
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
