import { assertBuilderDatabaseUrlForRuntime } from "../apps/builder-egghead/src/db/runtime-guard";
import {
  type BuilderSmokeProbeResult,
  runBuilderBetaSmokeProbe,
} from "../apps/builder-egghead/src/db/smoke-probe";

type GuardCheck = {
  name: string;
  pass: boolean;
};

type ProbeOutput =
  | {
      skipped: true;
      reason: string;
    }
  | {
      skipped: false;
      pass: boolean;
      result: BuilderSmokeProbeResult;
    };

type SmokeOutput = {
  ok: boolean;
  mode: "guard-only" | "guard+beta-probe";
  guard: {
    checks: GuardCheck[];
  };
  probe: ProbeOutput;
  guardrails: {
    productionRuntimeBlocked: true;
    betaRequiresApprovalEnv: true;
    writesPerformed: false;
    secretsPrinted: false;
  };
};

type EnvName =
  | "BETA_DATABASE_URL"
  | "BUILDER_SMOKE_TABLE_PREFIX"
  | "DATABASE_URL"
  | "EGGHEAD_BETA_DB_APPROVED"
  | "EGGHEAD_RUNTIME"
  | "NEXT_PUBLIC_APP_NAME";

type RuntimeGuardEnvSnapshot = {
  databaseUrl: string | undefined;
  betaApproved: string | undefined;
  runtime: string | undefined;
};

const localUrl = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const fakePlanetScaleUrl = "mysql://user:password@aws.connect.psdb.cloud/egghead?sslaccept=strict";

function env(name: EnvName) {
  return process.env[name];
}

function setEnv(name: EnvName, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function captureRuntimeGuardEnv(): RuntimeGuardEnvSnapshot {
  return {
    databaseUrl: env("DATABASE_URL"),
    betaApproved: env("EGGHEAD_BETA_DB_APPROVED"),
    runtime: env("EGGHEAD_RUNTIME"),
  };
}

function restoreRuntimeGuardEnv(snapshot: RuntimeGuardEnvSnapshot) {
  setEnv("DATABASE_URL", snapshot.databaseUrl);
  setEnv("EGGHEAD_BETA_DB_APPROVED", snapshot.betaApproved);
  setEnv("EGGHEAD_RUNTIME", snapshot.runtime);
}

function expectThrow(name: string, run: () => unknown): GuardCheck {
  try {
    run();
  } catch {
    return {
      name,
      pass: true,
    };
  }

  throw new Error(`${name}: expected runtime guard to throw`);
}

function expectPass(name: string, run: () => unknown): GuardCheck {
  run();

  return {
    name,
    pass: true,
  };
}

function runGuardMatrix() {
  const originalEnv = captureRuntimeGuardEnv();

  try {
    const checks: GuardCheck[] = [];

    setEnv("DATABASE_URL", localUrl);
    setEnv("EGGHEAD_RUNTIME", "local");
    setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
    checks.push(
      expectPass("local runtime accepts local Docker database", () =>
        assertBuilderDatabaseUrlForRuntime(),
      ),
    );

    setEnv("DATABASE_URL", fakePlanetScaleUrl);
    setEnv("EGGHEAD_RUNTIME", "local");
    setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
    checks.push(
      expectThrow("local runtime rejects PlanetScale database", () =>
        assertBuilderDatabaseUrlForRuntime(),
      ),
    );

    setEnv("DATABASE_URL", fakePlanetScaleUrl);
    setEnv("EGGHEAD_RUNTIME", "beta");
    setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
    checks.push(
      expectThrow("beta runtime rejects unapproved PlanetScale database", () =>
        assertBuilderDatabaseUrlForRuntime(),
      ),
    );

    setEnv("DATABASE_URL", fakePlanetScaleUrl);
    setEnv("EGGHEAD_RUNTIME", "beta");
    setEnv("EGGHEAD_BETA_DB_APPROVED", "true");
    checks.push(
      expectPass("beta runtime accepts approved PlanetScale database", () =>
        assertBuilderDatabaseUrlForRuntime(),
      ),
    );

    setEnv("DATABASE_URL", localUrl);
    setEnv("EGGHEAD_RUNTIME", "beta");
    setEnv("EGGHEAD_BETA_DB_APPROVED", "true");
    checks.push(
      expectThrow("beta runtime rejects local Docker database", () =>
        assertBuilderDatabaseUrlForRuntime(),
      ),
    );

    setEnv("DATABASE_URL", localUrl);
    setEnv("EGGHEAD_RUNTIME", "production");
    setEnv("EGGHEAD_BETA_DB_APPROVED", undefined);
    checks.push(
      expectThrow("production runtime is blocked", () => assertBuilderDatabaseUrlForRuntime()),
    );

    return checks;
  } finally {
    restoreRuntimeGuardEnv(originalEnv);
  }
}

function missingProbeReason() {
  if (env("EGGHEAD_BETA_DB_APPROVED") !== "true") {
    return "EGGHEAD_BETA_DB_APPROVED is missing";
  }

  if (!env("BETA_DATABASE_URL")) {
    return "BETA_DATABASE_URL is missing";
  }

  return null;
}

function builderSmokeTablePrefix() {
  return env("BUILDER_SMOKE_TABLE_PREFIX") ?? env("NEXT_PUBLIC_APP_NAME") ?? "egghead";
}

function allRequiredTablesExist(result: BuilderSmokeProbeResult) {
  return result.tables.every((table) => table.exists);
}

async function runProbeIfApproved(): Promise<ProbeOutput> {
  const reason = missingProbeReason();

  if (reason !== null) {
    return {
      skipped: true,
      reason,
    };
  }

  const originalRuntime = env("EGGHEAD_RUNTIME");
  const databaseUrl = env("BETA_DATABASE_URL");

  if (databaseUrl === undefined || databaseUrl === "") {
    return {
      skipped: true,
      reason: "BETA_DATABASE_URL is missing",
    };
  }

  try {
    setEnv("EGGHEAD_RUNTIME", "beta");

    const result = await runBuilderBetaSmokeProbe({
      databaseUrl,
      tablePrefix: builderSmokeTablePrefix(),
    });

    return {
      skipped: false,
      pass: result.select1 && allRequiredTablesExist(result),
      result,
    };
  } finally {
    setEnv("EGGHEAD_RUNTIME", originalRuntime);
  }
}

function outputGuardrails() {
  return {
    productionRuntimeBlocked: true,
    betaRequiresApprovalEnv: true,
    writesPerformed: false,
    secretsPrinted: false,
  } as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function decodedUrlCredentials(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const credentials: string[] = [];

    for (const credential of [url.password, url.username]) {
      if (!credential) continue;

      credentials.push(credential);

      try {
        credentials.push(decodeURIComponent(credential));
      } catch {
        // keep the raw form only
      }
    }

    return credentials;
  } catch {
    return [];
  }
}

function redactMessage(message: string) {
  const betaDatabaseUrl = env("BETA_DATABASE_URL");

  if (!betaDatabaseUrl) return message;

  let redacted = message.split(betaDatabaseUrl).join("[redacted]");

  for (const secret of decodedUrlCredentials(betaDatabaseUrl)) {
    if (secret) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }

  return redacted;
}

function emitJson(output: SmokeOutput | { ok: false; error: string }) {
  console.log(JSON.stringify(output));
}

async function main() {
  const requireBeta = process.argv.includes("--require-beta");
  const checks = runGuardMatrix();
  const probe = await runProbeIfApproved();
  const mode = probe.skipped ? "guard-only" : "guard+beta-probe";
  const probePassed = probe.skipped ? !requireBeta : probe.pass;
  const ok = checks.every((check) => check.pass) && probePassed;

  emitJson({
    ok,
    mode,
    guard: {
      checks,
    },
    probe,
    guardrails: outputGuardrails(),
  });

  process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
  emitJson({
    ok: false,
    error: redactMessage(errorMessage(error)),
  });
  process.exitCode = 1;
});
