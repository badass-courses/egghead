import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ShadowRecord } from "./projection";

/** Separate storage only. No app database or membership writer is permitted here. */
export interface ShadowStore {
  claim(eventId: string, token: string): Promise<"claimed" | "complete" | "busy">;
  complete(eventId: string, token: string, record: ShadowRecord): Promise<boolean>;
  release(eventId: string, token: string): Promise<void>;
}

export class MemoryShadowStore implements ShadowStore {
  readonly records = new Map<string, ShadowRecord>();
  private readonly claims = new Map<string, { token: string; expiresAt: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  async claim(eventId: string, token: string) {
    if (this.records.has(eventId)) return "complete" as const;
    const prior = this.claims.get(eventId);
    if (prior && prior.expiresAt > this.now()) return "busy" as const;
    this.claims.set(eventId, { token, expiresAt: this.now() + 300_000 });
    return "claimed" as const;
  }
  async complete(eventId: string, token: string, record: ShadowRecord) {
    const claim = this.claims.get(eventId);
    if (claim?.token !== token || claim.expiresAt <= this.now() || this.records.has(eventId))
      return false;
    this.records.set(eventId, record);
    this.claims.delete(eventId);
    return true;
  }
  async release(eventId: string, token: string) {
    if (this.claims.get(eventId)?.token === token) this.claims.delete(eventId);
  }
}

const claimKey = (id: string) => `{subscription-shadow}:claim:${id}`;

/**
 * State machine: absent -> claimed (5m lease) -> complete (no TTL).
 * Failure releases only our claim. Expiry permits recovery after a crashed worker.
 * Completion atomically persists the JSONL-shaped record and the permanent claim;
 * a stale worker can neither complete nor release its successor's lease.
 * Provision a dedicated Redis database, not the application/customer database.
 */
export function createRedisShadowStore(
  url: string,
  token: string,
  request: typeof fetch = fetch,
): ShadowStore {
  if (new URL(url).protocol !== "https:") throw new Error("Shadow store requires HTTPS");
  const command = async (args: (string | number)[]) => {
    const response = await request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Shadow store unavailable");
    const parsed = z
      .object({ result: z.unknown(), error: z.string().optional() })
      .parse(await response.json());
    if (parsed.error) throw new Error("Shadow store command failed");
    return parsed.result;
  };
  // Hash-tag keeps all keys in one Redis cluster slot. Record IDs are Stripe IDs only.
  const recordKey = "{subscription-shadow}:records";
  return {
    claim: async (id, lease) => {
      const result = await command([
        "EVAL",
        "if redis.call('HEXISTS',KEYS[2],ARGV[1]) == 1 then return 'complete' end; if redis.call('SET',KEYS[1],ARGV[2],'NX','EX',300) then return 'claimed' end; return 'busy'",
        2,
        claimKey(id),
        recordKey,
        id,
        lease,
      ]);
      return z.enum(["claimed", "complete", "busy"]).parse(result);
    },
    complete: async (id, lease, record) =>
      (await command([
        "EVAL",
        "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; if redis.call('HSETNX',KEYS[2],ARGV[2],ARGV[3]) == 0 then return 0 end; redis.call('SET',KEYS[1],'complete'); return 1",
        2,
        claimKey(id),
        recordKey,
        lease,
        id,
        JSON.stringify(record),
      ])) === 1,
    release: async (id, lease) => {
      await command([
        "EVAL",
        "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",
        1,
        claimKey(id),
        lease,
      ]);
    },
  };
}

/** Claim before any resolution/dispatch. Duplicate deliveries produce no second record. */
export async function recordShadowOnce(
  eventId: string,
  store: ShadowStore,
  project: () => Promise<ShadowRecord>,
  log: (record: ShadowRecord) => void,
) {
  const token = randomUUID();
  const claimed = await store.claim(eventId, token);
  if (claimed === "complete") return { status: "duplicate" as const };
  if (claimed === "busy") throw new Error("Shadow event is being processed; retry");
  let committed = false;
  try {
    const record = await project();
    committed = await store.complete(eventId, token, record);
    if (!committed) throw new Error("Shadow lease expired; retry");
    // Redis is canonical. Console is a queryable mirror, never the idempotency source.
    log(record);
    return { status: "recorded" as const, record };
  } catch (error) {
    if (!committed) await store.release(eventId, token);
    throw error;
  }
}
