import { randomUUID } from "node:crypto";
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
    // MySQL is canonical. Console is a queryable mirror, never the idempotency source.
    log(record);
    return { status: "recorded" as const, record };
  } catch (error) {
    if (!committed) await store.release(eventId, token);
    throw error;
  }
}
