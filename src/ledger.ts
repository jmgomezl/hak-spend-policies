import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SpendRecord {
  id: string;
  asset: string;
  /** Base units, as a decimal string so the record survives JSON. */
  amount: string;
  /** Epoch milliseconds when the spend was reserved. */
  at: number;
  /**
   * `reserved` while the tool call is in flight, `committed` once it succeeded. A reservation
   * that is never committed (the transaction failed, or a later policy blocked the call) lapses
   * after `reservationTtlMs`.
   */
  status: "reserved" | "committed";
  expiresAt?: number;
  method?: string;
}

/** Where a ledger keeps its records. Implement this to back it with Redis, SQLite, HCS, … */
export interface SpendStore {
  load(): SpendRecord[];
  save(records: readonly SpendRecord[]): void;
}

export class MemorySpendStore implements SpendStore {
  private records: SpendRecord[] = [];

  load(): SpendRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  save(records: readonly SpendRecord[]): void {
    this.records = records.map((record) => ({ ...record }));
  }
}

/**
 * Keeps the ledger in a JSON file so daily totals survive a restart. Writes go to a temporary
 * file first and are renamed into place, so a crash never leaves half a ledger behind.
 */
export class FileSpendStore implements SpendStore {
  constructor(private readonly path: string) {}

  load(): SpendRecord[] {
    if (!existsSync(this.path)) return [];
    const parsed = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${this.path} is not a spend ledger`);
    return parsed as SpendRecord[];
  }

  save(records: readonly SpendRecord[]): void {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

export interface SpendLedgerOptions {
  store?: SpendStore;
  /** How long an uncommitted reservation holds budget. Default 2 minutes. */
  reservationTtlMs?: number;
  /** How long committed records are kept. Default 8 days, enough for any daily window. */
  retentionMs?: number;
  now?: () => number;
}

/**
 * Running record of what the agent has spent. Budget is reserved when a call passes the policy
 * and committed when the call succeeds, so two calls made in parallel cannot both squeeze under
 * the same remaining cap.
 */
export class SpendLedger {
  private readonly store: SpendStore;
  private readonly reservationTtlMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private records: SpendRecord[];
  private counter = 0;

  constructor(options: SpendLedgerOptions = {}) {
    this.store = options.store ?? new MemorySpendStore();
    this.reservationTtlMs = options.reservationTtlMs ?? 2 * 60_000;
    this.retentionMs = options.retentionMs ?? 8 * 24 * 3_600_000;
    this.now = options.now ?? Date.now;
    this.records = this.store.load();
  }

  /** Holds budget for an in-flight call. Returns the reservation ID to commit or release. */
  reserve(amounts: ReadonlyMap<string, bigint>, method?: string): string {
    this.prune();
    const at = this.now();
    const id = `${at.toString(36)}-${(this.counter++).toString(36)}`;
    for (const [asset, amount] of amounts) {
      if (amount <= 0n) continue;
      this.records.push({
        id,
        asset,
        amount: amount.toString(),
        at,
        status: "reserved",
        expiresAt: at + this.reservationTtlMs,
        method,
      });
    }
    this.persist();
    return id;
  }

  commit(id: string): void {
    let changed = false;
    for (const record of this.records) {
      if (record.id === id && record.status === "reserved") {
        record.status = "committed";
        record.expiresAt = undefined;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  release(id: string): void {
    const before = this.records.length;
    this.records = this.records.filter(
      (record) => !(record.id === id && record.status === "reserved"),
    );
    if (this.records.length !== before) this.persist();
  }

  /** Committed spend plus live reservations for `asset` at or after `sinceMs`. */
  spentSince(asset: string, sinceMs: number): bigint {
    const now = this.now();
    let total = 0n;
    for (const record of this.records) {
      if (record.asset !== asset || record.at < sinceMs) continue;
      if (record.status === "reserved" && (record.expiresAt ?? 0) <= now) continue;
      total += BigInt(record.amount);
    }
    return total;
  }

  /** Records a spend that happened outside the agent, e.g. one replayed from the mirror node. */
  recordExternal(asset: string, amount: bigint, atMs: number, method = "external"): void {
    this.records.push({
      id: `ext-${atMs.toString(36)}-${(this.counter++).toString(36)}`,
      asset,
      amount: amount.toString(),
      at: atMs,
      status: "committed",
      method,
    });
    this.persist();
  }

  entries(): readonly SpendRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  private prune(): void {
    const now = this.now();
    this.records = this.records.filter((record) =>
      record.status === "reserved"
        ? (record.expiresAt ?? 0) > now
        : record.at >= now - this.retentionMs,
    );
  }

  private persist(): void {
    this.store.save(this.records);
  }
}
