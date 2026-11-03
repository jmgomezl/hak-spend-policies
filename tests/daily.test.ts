import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { describe, expect, it } from "vitest";
import { FileSpendStore, SpendLedger } from "../src/ledger";
import { DailySpendCapPolicy } from "../src/policies/daily-spend-cap";
import { HOUR, SHOP, USDC, clock, runTool } from "./helpers";

const pay = (amount: number) => ({ transfers: [{ accountId: SHOP, amount }] });

function setup(start = "2026-10-21T15:00:00Z", ttlMs?: number) {
  const time = clock(start);
  const ledger = new SpendLedger({ now: time.nowMs, reservationTtlMs: ttlMs });
  const policy = new DailySpendCapPolicy({
    caps: { HBAR: 10, [USDC]: { amount: 100, decimals: 6 } },
    ledger,
    now: time.now,
  });
  return { time, ledger, policy };
}

/** CUSTOM_EXECUTE_TX with a strategy that pretends to submit, so success and failure are real. */
const executing = (fail = false): Partial<Context> => ({
  mode: AgentMode.CUSTOM_EXECUTE_TX,
  transactionStrategy: {
    handle: async () => {
      if (fail) throw new Error("INSUFFICIENT_PAYER_BALANCE");
      return { raw: { status: "SUCCESS", transactionId: "0.0.1001@1.1" }, humanMessage: "sent" };
    },
  } as unknown as Context["transactionStrategy"],
});

describe("DailySpendCapPolicy", () => {
  it("adds up successful payments and refuses the one that crosses the cap", async () => {
    const { policy } = setup();
    expect((await runTool("transfer_hbar_tool", pay(4), [policy])).ok).toBe(true);
    expect((await runTool("transfer_hbar_tool", pay(4), [policy])).ok).toBe(true);
    const third = await runTool("transfer_hbar_tool", pay(3), [policy]);
    expect(third.ok).toBe(false);
    expect(third.message).toContain(
      "3 HBAR would bring spending in the last 24 hours to 11 HBAR, over the cap of 10 HBAR " +
        "(8 HBAR already spent, 2 HBAR left)",
    );
    expect((await runTool("transfer_hbar_tool", pay(2), [policy])).ok).toBe(true);
  });

  it("frees budget as old spends roll out of the 24-hour window", async () => {
    const { policy, time } = setup();
    await runTool("transfer_hbar_tool", pay(10), [policy]);
    time.advance(23 * HOUR);
    expect((await runTool("transfer_hbar_tool", pay(1), [policy])).ok).toBe(false);
    time.advance(1 * HOUR + 1);
    expect((await runTool("transfer_hbar_tool", pay(10), [policy])).ok).toBe(true);
  });

  it("resets at local midnight with a calendar window", async () => {
    const time = clock("2026-10-22T04:30:00Z"); // 23:30 in Bogotá
    const policy = new DailySpendCapPolicy({
      caps: { HBAR: 10 },
      ledger: new SpendLedger({ now: time.nowMs }),
      window: { type: "calendar", timeZone: "America/Bogota" },
      now: time.now,
    });
    await runTool("transfer_hbar_tool", pay(10), [policy]);
    expect((await runTool("transfer_hbar_tool", pay(1), [policy])).ok).toBe(false);
    time.advance(31 * 60_000); // 00:01 the next day in Bogotá
    const next = await runTool("transfer_hbar_tool", pay(10), [policy]);
    expect(next.ok).toBe(true);
  });

  it("tracks each asset separately", async () => {
    const { policy } = setup();
    await runTool("transfer_hbar_tool", pay(10), [policy]);
    const usdc = await runTool(
      "transfer_fungible_token_tool",
      { tokenId: USDC, transfers: [{ accountId: SHOP, amount: 99 }] },
      [policy],
    );
    expect(usdc.ok).toBe(true);
    expect(policy.budget().map((line) => [line.asset, line.remaining])).toEqual([
      ["HBAR", 0n],
      [USDC, 1_000_000n],
    ]);
  });

  it("commits only when the transaction succeeds", async () => {
    const { policy, ledger } = setup("2026-10-21T15:00:00Z", 60_000);
    await runTool("transfer_hbar_tool", pay(6), [policy], executing());
    expect(ledger.entries().map((entry) => entry.status)).toEqual(["committed"]);

    const failed = await runTool("transfer_hbar_tool", pay(4), [policy], executing(true));
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("INSUFFICIENT_PAYER_BALANCE");
    expect(ledger.entries().map((entry) => entry.status)).toEqual(["committed", "reserved"]);
  });

  it("gives back a failed call's budget when its reservation lapses", async () => {
    const { policy, time } = setup("2026-10-21T15:00:00Z", 60_000);
    await runTool("transfer_hbar_tool", pay(6), [policy], executing(true));
    // Held while the failure might still be a slow success…
    expect((await runTool("transfer_hbar_tool", pay(6), [policy], executing())).ok).toBe(false);
    time.advance(60_001);
    // …then released.
    expect((await runTool("transfer_hbar_tool", pay(6), [policy], executing())).ok).toBe(true);
  });

  it("does not let two parallel calls share the same remaining budget", async () => {
    const { policy } = setup();
    const results = await Promise.all([
      runTool("transfer_hbar_tool", pay(6), [policy]),
      runTool("transfer_hbar_tool", pay(6), [policy]),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
  });

  it("refuses uncapped assets by default", async () => {
    const { policy } = setup();
    const outcome = await runTool(
      "transfer_fungible_token_tool",
      { tokenId: "0.0.999", transfers: [{ accountId: SHOP, amount: 1 }] },
      [policy],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("0.0.999 has no daily cap");
  });
});

describe("FileSpendStore", () => {
  it("keeps the day's spending across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "spend-")), "ledger.json");
    const time = clock("2026-10-21T15:00:00Z");
    const first = new DailySpendCapPolicy({
      caps: { HBAR: 10 },
      ledger: new SpendLedger({ store: new FileSpendStore(path), now: time.nowMs }),
      now: time.now,
    });
    await runTool("transfer_hbar_tool", pay(8), [first]);

    const restarted = new DailySpendCapPolicy({
      caps: { HBAR: 10 },
      ledger: new SpendLedger({ store: new FileSpendStore(path), now: time.nowMs }),
      now: time.now,
    });
    expect((await runTool("transfer_hbar_tool", pay(3), [restarted])).ok).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
  });
});
