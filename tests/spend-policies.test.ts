import { RejectToolPolicy } from "@hashgraph/hedera-agent-kit/policies";
import { describe, expect, it, vi } from "vitest";
import { spendPolicyToolNames } from "../src/index";
import { DailySpendCapPolicy } from "../src/policies/daily-spend-cap";
import { PayeeAllowlistPolicy } from "../src/policies/payee-allowlist";
import { PerTxCapPolicy } from "../src/policies/per-tx-cap";
import { TimeWindowPolicy } from "../src/policies/time-window";
import { spendPolicies } from "../src/spend-policies";
import { AGENT, OWNER, SHOP, STRANGER, USDC, client, clock, contextWith, runTool } from "./helpers";

const weekdayHours = {
  timeZone: "America/Bogota",
  windows: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00" }],
};

function build(overrides = {}) {
  const time = clock("2026-10-21T15:00:00Z"); // Wednesday 10:00 in Bogotá
  const submit = vi.fn(async () => ({ scheduleId: "0.0.5005", transactionId: "0.0.1001@1.1" }));
  const spend = spendPolicies({
    perTransaction: { HBAR: 5 },
    daily: { HBAR: 12, [USDC]: { amount: 100, decimals: 6 } },
    payees: [SHOP],
    hours: weekdayHours,
    approval: { ownerAccountId: OWNER, submit },
    now: time.now,
    ...overrides,
  });
  return { spend, time, submit };
}

describe("spendPolicies", () => {
  it("orders the hooks so the daily cap reserves budget last", () => {
    const { spend } = build();
    expect(spend.hooks.map((hook) => hook.constructor)).toEqual([
      RejectToolPolicy,
      TimeWindowPolicy,
      PayeeAllowlistPolicy,
      PerTxCapPolicy,
      DailySpendCapPolicy,
    ]);
  });

  it("refuses value-moving tools it cannot measure", async () => {
    const { spend } = build();
    const sweep = await runTool(
      "delete_account_tool",
      { accountId: AGENT, transferAccountId: STRANGER },
      spend.hooks,
    );
    expect(sweep.ok).toBe(false);
    expect(sweep.message).toContain("blocked by policy");

    const cosign = await runTool(
      "sign_schedule_transaction_tool",
      { scheduleId: "0.0.4444" },
      spend.hooks,
    );
    expect(cosign.ok).toBe(false);
  });

  it("stops refusing an uncovered tool once it has an extractor", () => {
    const { spend } = build({ extractors: { transfer_erc20_tool: () => [] } });
    const reject = spend.hooks[0] as RejectToolPolicy;
    expect(reject.relevantTools).not.toContain("transfer_erc20_tool");
    expect(reject.relevantTools).toContain("delete_account_tool");
  });

  it("escalates cap breaches to the owner but refuses unknown payees outright by default", async () => {
    const { spend, submit } = build();
    const overCap = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 6 }] },
      spend.hooks,
    );
    expect(overCap.message).toContain("scheduled transaction 0.0.5005");

    const stranger = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: STRANGER, amount: 1 }] },
      spend.hooks,
    );
    expect(stranger.message).toContain("not on the payee allowlist");
    expect(stranger.message).not.toContain("scheduled transaction");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("escalates whichever refusals the config names", async () => {
    const { spend, submit } = build({
      approval: {
        ownerAccountId: OWNER,
        submit: vi.fn(async () => ({ scheduleId: "0.0.6006", transactionId: "x" })),
        escalate: ["payees"],
      },
    });
    const stranger = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: STRANGER, amount: 1 }] },
      spend.hooks,
    );
    expect(stranger.message).toContain("scheduled transaction 0.0.6006");
    expect(submit).not.toHaveBeenCalled();
  });

  it("enforces every policy in one pass, end to end", async () => {
    const { spend, time } = build();
    const pay = (amount: number) => ({ transfers: [{ accountId: SHOP, amount }] });
    expect((await runTool("transfer_hbar_tool", pay(5), spend.hooks)).ok).toBe(true);
    expect((await runTool("transfer_hbar_tool", pay(5), spend.hooks)).ok).toBe(true);
    const third = await runTool("transfer_hbar_tool", pay(5), spend.hooks);
    expect(third.message).toContain("[Daily Spend Cap]");
    time.set("2026-10-24T15:00:00Z"); // Saturday
    const weekend = await runTool("transfer_hbar_tool", pay(1), spend.hooks);
    expect(weekend.message).toContain("[Time Window]");
  });
});

describe("plugin tools", () => {
  it("exposes the budget and approval-status tools", () => {
    const { spend } = build();
    expect(spend.plugin.tools(contextWith([])).map((tool) => tool.method)).toEqual(
      Object.values(spendPolicyToolNames),
    );
  });

  it("spend_get_budget reports what is left", async () => {
    const { spend } = build();
    await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 4.5 }] },
      spend.hooks,
    );
    await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 9 }] },
      spend.hooks,
    );

    const context = contextWith(spend.hooks);
    const budget = spend.plugin.tools(context).find((t) => t.method === "spend_get_budget");
    const result = await budget?.execute(client, context, {});
    expect(result.humanMessage).toContain("Per transaction: 5 HBAR");
    expect(result.humanMessage).toContain("7.5 HBAR left of 12 HBAR");
    expect(result.humanMessage).toContain(`100 of ${USDC} left of 100 of ${USDC}`);
    expect(result.humanMessage).toContain("Allowed payees: 0.0.800");
    expect(result.humanMessage).toContain("Inside allowed hours");
    expect(result.humanMessage).toContain("Waiting for owner approval: 0.0.5005");
    expect(result.raw.daily.assets[0]).toEqual({
      asset: "HBAR",
      limit: "12 HBAR",
      spent: "4.5 HBAR",
      remaining: "7.5 HBAR",
    });
  });

  it("spend_approval_status reads the schedule from the mirror node", async () => {
    const { spend } = build();
    const statusOf = async (details: Record<string, unknown>) => {
      const context = contextWith([], {
        mirrornodeService: {
          getScheduledTransactionDetails: async () => ({
            deleted: false,
            executed_timestamp: null,
            expiration_time: "1893456000.000000000",
            memo: "agent payment approval: 6 HBAR to 0.0.800",
            signatures: [{}],
            ...details,
          }),
        } as never,
      });
      const tool = spend.plugin.tools(context).find((t) => t.method === "spend_approval_status");
      return tool?.execute(client, context, { scheduleId: "0.0.5005" });
    };

    expect((await statusOf({})).raw.state).toBe("pending");
    const approved = await statusOf({ executed_timestamp: "1761060000.123456789" });
    expect(approved.raw.state).toBe("approved");
    expect(approved.humanMessage).toContain("approved and the payment executed");
    expect((await statusOf({ deleted: true })).raw.state).toBe("rejected");
    expect((await statusOf({ expiration_time: "1600000000.0" })).raw.state).toBe("expired");
  });

  it("rejects a malformed schedule ID before touching the network", async () => {
    const { spend } = build();
    const context = contextWith([]);
    const tool = spend.plugin.tools(context).find((t) => t.method === "spend_approval_status");
    const result = await tool?.execute(client, context, { scheduleId: "five" });
    expect(result.raw.status).toBe("ERROR");
  });
});
