import {
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
} from "../apps/web/src/db/local-docker";

type RuntimeGuardCheck = {
  name: string;
  pass: true;
};

const originalEnv = {
  databaseUrl: process.env["DATABASE_URL"],
  betaApproved: process.env["EGGHEAD_BETA_DB_APPROVED"],
  runtime: process.env["EGGHEAD_RUNTIME"],
};

function restoreEnv() {
  setEnv("DATABASE_URL", originalEnv.databaseUrl);
  setEnv("EGGHEAD_BETA_DB_APPROVED", originalEnv.betaApproved);
  setEnv("EGGHEAD_RUNTIME", originalEnv.runtime);
}

function setEnv(
  name: "DATABASE_URL" | "EGGHEAD_BETA_DB_APPROVED" | "EGGHEAD_RUNTIME",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function expectThrow(name: string, run: () => unknown) {
  try {
    run();
  } catch {
    return {
      name,
      pass: true as const,
    };
  }

  throw new Error(`${name}: expected runtime guard to throw`);
}

function expectPass(name: string, run: () => unknown) {
  run();

  return {
    name,
    pass: true as const,
  };
}

const localUrl = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const fakePlanetScaleUrl = "mysql://user:password@aws.connect.psdb.cloud/egghead?sslaccept=strict";

try {
  const checks: RuntimeGuardCheck[] = [];

  setEnv("DATABASE_URL", localUrl);
  setEnv("EGGHEAD_RUNTIME", "local");
  setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
  checks.push(
    expectPass("local runtime accepts local Docker database", () => assertDatabaseUrlForRuntime()),
  );

  setEnv("DATABASE_URL", fakePlanetScaleUrl);
  setEnv("EGGHEAD_RUNTIME", "local");
  setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
  checks.push(
    expectThrow("local runtime rejects PlanetScale database", () => assertDatabaseUrlForRuntime()),
  );

  setEnv("DATABASE_URL", fakePlanetScaleUrl);
  setEnv("EGGHEAD_RUNTIME", "beta");
  setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
  checks.push(
    expectThrow("beta runtime rejects unapproved PlanetScale database", () =>
      assertDatabaseUrlForRuntime(),
    ),
  );

  setEnv("DATABASE_URL", fakePlanetScaleUrl);
  setEnv("EGGHEAD_RUNTIME", "beta");
  setEnv("EGGHEAD_BETA_DB_APPROVED", "true");
  checks.push(
    expectPass("beta runtime accepts approved PlanetScale database", () =>
      assertDatabaseUrlForRuntime(),
    ),
  );
  checks.push(
    expectThrow("beta runtime still rejects commerce writes", () => assertCommerceWritesAllowed()),
  );

  setEnv("DATABASE_URL", localUrl);
  setEnv("EGGHEAD_RUNTIME", "production");
  setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
  checks.push(
    expectThrow("production runtime rejects local Docker", () => assertDatabaseUrlForRuntime()),
  );

  setEnv("DATABASE_URL", fakePlanetScaleUrl);
  checks.push(
    expectPass("production runtime accepts PlanetScale", () => assertDatabaseUrlForRuntime()),
    expectPass("production runtime accepts commerce writes", () => assertCommerceWritesAllowed()),
  );

  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.map((check) => ({
        name: check.name,
        pass: check.pass,
      })),
      guardrails: {
        betaRequiresExplicitRuntime: true,
        betaRequiresApprovalEnv: true,
        productionRequiresPlanetScale: true,
        betaCommerceWritesBlocked: true,
        realDatabaseUrlUsed: false,
      },
    }),
  );
} finally {
  restoreEnv();
}
