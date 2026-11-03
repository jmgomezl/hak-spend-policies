import { AccountId, Client, Hbar, PrivateKey, TokenId } from "@hiero-ledger/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalRequest,
  MAX_APPROVAL_SECONDS,
  ScheduledApproval,
} from "../src/approval/scheduled-approval";
import { SpendPolicyViolation } from "../src/errors";
import { PayeeAllowlistPolicy } from "../src/policies/payee-allowlist";
import { PerTxCapPolicy } from "../src/policies/per-tx-cap";
import { CAFE, NFT, OWNER, SHOP, STRANGER, USDC, clock, hbarIntent, runTool } from "./helpers";

function fakeSubmit(scheduleId = "0.0.5005") {
  return vi.fn(async () => ({ scheduleId, transactionId: "0.0.1001@1761000000.000000000" }));
}

describe("ScheduledApproval.buildTransfer", () => {
  const approval = new ScheduledApproval({ ownerAccountId: OWNER });

  it("pays the same recipients from the owner's account", () => {
    const transfer = approval.buildTransfer({
      method: "transfer_hbar_tool",
      scheduled: false,
      items: [
        { asset: "HBAR", amount: 700_000_000n, to: SHOP, kind: "transfer" },
        { asset: "HBAR", amount: 100_000_000n, to: CAFE, kind: "transfer" },
      ],
    });
    const hbar = transfer.hbarTransfers;
    expect(hbar.get(AccountId.fromString(SHOP))?.toTinybars().toString()).toBe("700000000");
    expect(hbar.get(AccountId.fromString(CAFE))?.toTinybars().toString()).toBe("100000000");
    expect(hbar.get(AccountId.fromString(OWNER))?.toTinybars().toString()).toBe("-800000000");
  });

  it("handles HTS tokens in base units", () => {
    const transfer = approval.buildTransfer({
      method: "transfer_fungible_token_tool",
      scheduled: false,
      items: [{ asset: USDC, amount: 50_000_000n, to: SHOP, kind: "transfer" }],
    });
    const usdc = transfer.tokenTransfers.get(TokenId.fromString(USDC));
    expect(usdc?.get(AccountId.fromString(SHOP))?.toString()).toBe("50000000");
    expect(usdc?.get(AccountId.fromString(OWNER))?.toString()).toBe("-50000000");
  });

  it("only escalates fungible transfers", () => {
    expect(
      approval.canEscalate({
        method: "transfer_non_fungible_token_tool",
        scheduled: false,
        items: [{ asset: NFT, amount: 1n, to: SHOP, kind: "nft" }],
      }),
    ).toBe(false);
    expect(
      approval.canEscalate({
        method: "approve_hbar_allowance_tool",
        scheduled: false,
        items: [{ asset: "HBAR", amount: 1n, to: SHOP, kind: "allowance" }],
      }),
    ).toBe(false);
  });
});

describe("ScheduledApproval.buildSchedule", () => {
  it("expires after the configured time, executes on signature, and keeps the memo short", () => {
    const time = clock("2026-10-21T15:00:00Z");
    const approval = new ScheduledApproval({
      ownerAccountId: OWNER,
      expiresInSeconds: 3_600,
      now: time.now,
    });
    const schedule = approval.buildSchedule({
      method: "transfer_hbar_tool",
      scheduled: false,
      items: Array.from({ length: 12 }, (_, i) => ({
        asset: "HBAR",
        amount: 100_000_000n,
        to: `0.0.${9_000_000 + i}`,
        kind: "transfer" as const,
      })),
    });
    expect(schedule.expirationTime?.toDate().toISOString()).toBe("2026-10-21T16:00:00.000Z");
    expect(schedule.waitForExpiry).toBe(false);
    const memo = schedule.getScheduleMemo ?? "";
    expect(memo.startsWith("agent payment approval: 12 HBAR to 0.0.9000000")).toBe(true);
    expect(new TextEncoder().encode(memo).length).toBeLessThanOrEqual(100);
  });

  it("validates the expiry", () => {
    expect(() => new ScheduledApproval({ ownerAccountId: OWNER, expiresInSeconds: 10 })).toThrow();
    expect(
      () =>
        new ScheduledApproval({
          ownerAccountId: OWNER,
          expiresInSeconds: MAX_APPROVAL_SECONDS + 1,
        }),
    ).toThrow();
  });
});

describe("escalation from a policy", () => {
  it("turns an over-cap payment into an owner approval and tells the model the schedule ID", async () => {
    const submit = fakeSubmit();
    const requested: ApprovalRequest[] = [];
    const approval = new ScheduledApproval({
      ownerAccountId: OWNER,
      submit,
      onRequested: (request) => {
        requested.push(request);
      },
    });
    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 }, approval });
    const outcome = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 8 }] },
      [policy],
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("8 HBAR is over the per-transaction cap of 5 HBAR");
    expect(outcome.message).toContain("scheduled transaction 0.0.5005");
    expect(outcome.message).toContain(`from ${OWNER}`);
    expect(outcome.message).toContain("Do not retry the payment");
    expect(submit).toHaveBeenCalledOnce();
    expect(requested).toEqual([
      expect.objectContaining({
        scheduleId: "0.0.5005",
        ownerAccountId: OWNER,
        method: "transfer_hbar_tool",
        items: [{ asset: "HBAR", amount: "800000000", to: SHOP }],
        reused: false,
      }),
    ]);
  });

  it("reuses the pending schedule when the model retries the same payment", async () => {
    const submit = fakeSubmit();
    const approval = new ScheduledApproval({ ownerAccountId: OWNER, submit });
    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 }, approval });
    const params = { transfers: [{ accountId: SHOP, amount: 8 }] };
    await runTool("transfer_hbar_tool", params, [policy]);
    const retry = await runTool("transfer_hbar_tool", params, [policy]);

    expect(submit).toHaveBeenCalledOnce();
    expect(retry.message).toContain("0.0.5005");
    expect(approval.pendingRequests()).toHaveLength(1);
  });

  it("asks again once the pending approval has expired", async () => {
    const time = clock("2026-10-21T15:00:00Z");
    const submit = fakeSubmit();
    const approval = new ScheduledApproval({
      ownerAccountId: OWNER,
      expiresInSeconds: 600,
      submit,
      now: time.now,
    });
    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 }, approval });
    const params = { transfers: [{ accountId: SHOP, amount: 8 }] };
    await runTool("transfer_hbar_tool", params, [policy]);
    time.advance(601_000);
    await runTool("transfer_hbar_tool", params, [policy]);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("refuses to use an owner the agent itself operates", async () => {
    const approval = new ScheduledApproval({ ownerAccountId: OWNER, submit: fakeSubmit() });
    const ownClient = Client.forTestnet().setOperator(OWNER, PrivateKey.generateED25519());
    await expect(
      approval.request(hbarIntent(SHOP, 800_000_000n), "over cap", ownClient),
    ).rejects.toThrow(/could approve its own payments/);

    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 }, approval });
    const thrown = await policy
      .postParamsNormalizationHook(
        {
          context: {},
          rawParams: {},
          normalisedParams: { hbarTransfers: [{ accountId: SHOP, amount: new Hbar(8) }] },
          client: ownClient,
          toolType: "transaction",
        },
        "transfer_hbar_tool",
      )
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(SpendPolicyViolation);
    expect((thrown as SpendPolicyViolation).approval).toBeUndefined();
    expect((thrown as Error).message).toContain("owner approval request failed");
  });

  it("reports a failed approval request and still refuses the payment", async () => {
    const approval = new ScheduledApproval({
      ownerAccountId: OWNER,
      submit: async () => {
        throw new Error("INSUFFICIENT_PAYER_BALANCE");
      },
    });
    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 }, approval });
    const outcome = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 8 }] },
      [policy],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("owner approval request failed: INSUFFICIENT_PAYER_BALANCE");
  });

  it("plainly refuses what cannot be re-issued from the owner, like an NFT", async () => {
    const submit = fakeSubmit();
    const approval = new ScheduledApproval({ ownerAccountId: OWNER, submit });
    const policy = new PayeeAllowlistPolicy({ payees: [SHOP], approval });
    const outcome = await runTool(
      "transfer_non_fungible_token_tool",
      { tokenId: NFT, recipients: [{ recipientId: STRANGER, serialNumber: 1 }] },
      [policy],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Do not retry it");
    expect(submit).not.toHaveBeenCalled();
  });
});
