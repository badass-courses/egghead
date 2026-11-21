import { createHmac } from "node:crypto";
import mysql from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shadowDependencies } from "../shadow/configuration";
import { shadowDatabaseOptions } from "../shadow/database-url";
import { handleShadowRequest } from "../shadow/handler";
import {
  createMysqlShadowStore,
  shadowTableNames,
  type ShadowMysqlConnection,
} from "../shadow/mysql-store";
import type { ShadowRecord } from "../shadow/projection";

const main = "mysql://branch:synthetic@aws.connect.psdb.cloud/egghead";
const isolated = "mysql://shadow-branch:synthetic@aws.connect.psdb.cloud/egghead";
const local = "mysql://shadow:synthetic@localhost/shadow_test";
const record: ShadowRecord = {
  name: "subscription.shadow.skipped",
  version: 1,
  stripeEventId: "evt_synthetic_sql",
  eventType: "invoice.paid",
  createdAt: 1,
  observedAt: 1000,
  count: 1,
  reason: "not-subscription",
  skippedSubscriptions: 0,
  tenantMetadataConflicts: 0,
  unresolvedDeletedCustomers: 0,
  subscriptions: [],
};
function stub() {
  const execute = vi.fn<ShadowMysqlConnection["execute"]>();
  const db = {
    execute,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  } satisfies ShadowMysqlConnection;
  return { db, execute, store: createMysqlShadowStore(local, { connect: async () => db }) };
}
afterEach(() => vi.restoreAllMocks());

describe("isolated shadow MySQL target", () => {
  it.each([
    main,
    "mysql://branch:different@aws.connect.psdb.cloud/egghead?sslaccept=strict",
    "mysql://%62ranch:synthetic@AWS.CONNECT.PSDB.CLOUD/another_database",
    "mysql://branch:synthetic@aws.connect.psdb.cloud:3307/egghead",
  ])("refuses the main host/branch user before connecting (%#)", async (url) => {
    const connect = vi.spyOn(mysql, "createConnection");
    const now = Date.now();
    const timestamp = Math.floor(now / 1000);
    const body = JSON.stringify({
      id: "evt_synthetic_guard",
      type: "invoice.paid",
      created: timestamp,
      data: { object: { id: "in_synthetic" } },
    });
    const secret = "synthetic-webhook";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const response = await handleShadowRequest(
      new Request("https://example.test/api/stripe/subscription-shadow", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body,
      }),
      secret,
      () =>
        shadowDependencies({
          DATABASE_URL: main,
          STRIPE_SHADOW_READ_KEY: "rk_synthetic",
          STRIPE_SHADOW_DATABASE_URL: url,
        }),
      now,
    );
    expect(response.status).toBe(503);
    expect(connect).not.toHaveBeenCalled();
  });
  it("allows a distinct PlanetScale branch user, enforces TLS, and opens no connection", () => {
    const connect = vi.spyOn(mysql, "createConnection");
    const options = shadowDatabaseOptions(`${isolated}?sslaccept=accept_invalid_certs`, main);
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.user).toBe("shadow-branch");
    shadowDependencies({
      DATABASE_URL: main,
      STRIPE_SHADOW_READ_KEY: "rk_synthetic",
      STRIPE_SHADOW_DATABASE_URL: isolated,
    });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    "https://example.test",
    "mysql://branch:synthetic@example.test/egghead",
    "mysql://root:synthetic@localhost/coursebuilder_test",
    "mysql://root:synthetic@localhost/production",
  ])("refuses unsupported/default targets (%#)", (url) => {
    expect(() => shadowDatabaseOptions(url)).toThrow();
  });
  it("keeps branch usernames case-sensitive and rejects unsafe table identifiers", () => {
    expect(shadowDatabaseOptions(isolated.replace("shadow-branch", "Branch"), main).user).toBe(
      "Branch",
    );
    expect(() =>
      shadowTableNames({ claims: "ShadowEventClaim;DROP", records: "ShadowRecord" }),
    ).toThrow();
  });
});

describe("schema-checked MySQL protocol", () => {
  it("reclaims a duplicate only by affected rows, never by an overwrite", async () => {
    const { execute, store, db } = stub();
    execute
      .mockRejectedValueOnce({ code: "ER_DUP_ENTRY" })
      .mockResolvedValueOnce([[{ complete: 0 }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect(await store.claim(record.stripeEventId, "next")).toBe("claimed");
    expect(execute.mock.calls[2]?.[0]).toContain(
      "claimedUntil < UTC_TIMESTAMP(6) AND completedAt IS NULL",
    );
    expect(db.end).toHaveBeenCalledOnce();
  });
  it.each([0, 1])("rechecks completion after losing a reclaim race (%s)", async (complete) => {
    const { execute, store } = stub();
    execute
      .mockRejectedValueOnce({ code: "ER_DUP_ENTRY" })
      .mockResolvedValueOnce([[{ complete: 0 }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[{ complete }], []]);
    expect(await store.claim(record.stripeEventId, "loser")).toBe(complete ? "complete" : "busy");
  });
  it("never reclaims a completed event", async () => {
    const { execute, store } = stub();
    execute
      .mockRejectedValueOnce({ code: "ER_DUP_ENTRY" })
      .mockResolvedValueOnce([[{ complete: 1 }], []]);
    expect(await store.claim(record.stripeEventId, "next")).toBe("complete");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("rolls back and does not insert for a stale or expired completion", async () => {
    const { execute, store, db } = stub();
    execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    expect(await store.complete(record.stripeEventId, "stale", record)).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it("rolls back the claim when the canonical insert fails, redacting the driver error", async () => {
    const { execute, store, db } = stub();
    execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockRejectedValueOnce(new Error("private row"));
    await expect(store.complete(record.stripeEventId, "owner", record)).rejects.toThrow(
      "Shadow MySQL store unavailable",
    );
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it("does not reinterpret non-duplicate insertion failures as a claim collision", async () => {
    const { execute, store, db } = stub();
    execute.mockRejectedValueOnce({
      code: "ER_ACCESS_DENIED_ERROR",
      message: "private connection",
    });
    await expect(store.claim(record.stripeEventId, "owner")).rejects.toThrow(
      "Shadow MySQL store unavailable",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it("refuses mismatched event IDs before writing", async () => {
    const { execute, store } = stub();
    await expect(store.complete("evt_other", "owner", record)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
