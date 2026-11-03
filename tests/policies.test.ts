import { describe, expect, it } from "vitest";
import { builtinExtractors, extractIntent } from "../src/extract";
import { PayeeAllowlistPolicy } from "../src/policies/payee-allowlist";
import { PerTxCapPolicy } from "../src/policies/per-tx-cap";
import { TimeWindowPolicy } from "../src/policies/time-window";
import { AGENT, CAFE, NFT, SHOP, STRANGER, USDC, clock, runTool } from "./helpers";

const usdcCap = { amount: 20, decimals: 6 };

describe("spend extraction from real Agent Kit normalisation", () => {
  it("reads HBAR recipients and ignores the source debit", async () => {
    let seen: unknown;
    const spy = new PayeeAllowlistPolicy({
      payees: [SHOP, CAFE],
      extractors: {
        transfer_hbar_tool: (p, raw) => {
          seen = extractIntent("transfer_hbar_tool", p, raw, builtinExtractors, "spy");
          return [];
        },
      },
    });
    await runTool(
      "transfer_hbar_tool",
      {
        transfers: [
          { accountId: SHOP, amount: 1.5 },
          { accountId: CAFE, amount: 0.25 },
        ],
      },
      [spy],
    );
    expect(seen).toEqual({
      method: "transfer_hbar_tool",
      scheduled: false,
      items: [
        { asset: "HBAR", amount: 150_000_000n, to: SHOP, kind: "transfer" },
        { asset: "HBAR", amount: 25_000_000n, to: CAFE, kind: "transfer" },
      ],
    });
  });
});

describe("unexpected parameter shapes", () => {
  it("fails closed when a normalised field is missing", async () => {
    const policy = new PerTxCapPolicy({ caps: { HBAR: 5 } });
    await expect(
      policy.postParamsNormalizationHook(
        {
          context: {},
          rawParams: {},
          normalisedParams: { transfersRenamed: [] },
          client: {} as never,
          toolType: "transaction",
        },
        "transfer_hbar_tool",
      ),
    ).rejects.toThrow(/could not find 'hbarTransfers'/);
  });
});

describe("PerTxCapPolicy", () => {
  const policy = () => new PerTxCapPolicy({ caps: { HBAR: 5, [USDC]: usdcCap } });

  it("lets a payment under the cap through", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 5 }] },
      [policy()],
    );
    expect(outcome.ok).toBe(true);
  });

  it("refuses a payment over the cap and says why", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 5.00000001 }] },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("[Per-Transaction Cap]");
    expect(outcome.message).toContain("5.00000001 HBAR is over the per-transaction cap of 5 HBAR");
    expect(outcome.message).toContain("NOT submitted");
  });

  it("measures a split payment by its total", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      {
        transfers: [
          { accountId: SHOP, amount: 3 },
          { accountId: CAFE, amount: 3 },
        ],
      },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("6 HBAR");
  });

  it("caps HTS tokens in display units", async () => {
    const pass = await runTool(
      "transfer_fungible_token_tool",
      { tokenId: USDC, transfers: [{ accountId: SHOP, amount: 20 }] },
      [policy()],
    );
    const fail = await runTool(
      "transfer_fungible_token_tool",
      { tokenId: USDC, transfers: [{ accountId: SHOP, amount: 20.5 }] },
      [policy()],
    );
    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.message).toContain(
      `20.5 of ${USDC} is over the per-transaction cap of 20 of ${USDC}`,
    );
  });

  it("refuses assets that have no cap, unless told to allow them", async () => {
    const params = { tokenId: "0.0.999", transfers: [{ accountId: SHOP, amount: 1 }] };
    const strict = await runTool("transfer_fungible_token_tool", params, [policy()]);
    expect(strict.ok).toBe(false);
    expect(strict.message).toContain("0.0.999 has no per-transaction cap");

    const lenient = new PerTxCapPolicy({ caps: { HBAR: 5 }, allowUnlistedAssets: true });
    expect((await runTool("transfer_fungible_token_tool", params, [lenient])).ok).toBe(true);
  });

  it("counts an allowance grant as exposure", async () => {
    const outcome = await runTool(
      "approve_hbar_allowance_tool",
      { spenderAccountId: SHOP, amount: 50 },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("50 HBAR is over the per-transaction cap");
  });

  it("counts an airdrop by its total", async () => {
    const outcome = await runTool(
      "airdrop_fungible_token_tool",
      {
        tokenId: USDC,
        recipients: [
          { accountId: SHOP, amount: 15 },
          { accountId: CAFE, amount: 15 },
        ],
      },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`30 of ${USDC}`);
  });

  it("still counts a payment the agent schedules for itself", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      {
        transfers: [{ accountId: SHOP, amount: 6 }],
        schedulingParams: { isScheduled: true },
      },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("over the per-transaction cap");
  });
});

describe("PayeeAllowlistPolicy", () => {
  const policy = () => new PayeeAllowlistPolicy({ payees: [SHOP, `${CAFE}-abcde`] });

  it("pays allowlisted accounts, including ones written with a checksum", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      {
        transfers: [
          { accountId: SHOP, amount: 1 },
          { accountId: CAFE, amount: 1 },
        ],
      },
      [policy()],
    );
    expect(outcome.ok).toBe(true);
  });

  it("refuses a payment that includes anyone else", async () => {
    const outcome = await runTool(
      "transfer_hbar_tool",
      {
        transfers: [
          { accountId: SHOP, amount: 1 },
          { accountId: STRANGER, amount: 1 },
        ],
      },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`${STRANGER} is not on the payee allowlist`);
  });

  it("refuses an allowance to an outsider, which would let them take funds later", async () => {
    const outcome = await runTool(
      "approve_token_allowance_tool",
      { spenderAccountId: STRANGER, tokenApprovals: [{ tokenId: USDC, amount: 1 }] },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not on the payee allowlist");
  });

  it("refuses sending an NFT to an outsider", async () => {
    const outcome = await runTool(
      "transfer_non_fungible_token_tool",
      { tokenId: NFT, recipients: [{ recipientId: STRANGER, serialNumber: 1 }] },
      [policy()],
    );
    expect(outcome.ok).toBe(false);
  });

  it("can be limited to some outflow kinds", async () => {
    const transfersOnly = new PayeeAllowlistPolicy({ payees: [SHOP], kinds: ["transfer"] });
    const outcome = await runTool(
      "transfer_non_fungible_token_tool",
      { tokenId: NFT, recipients: [{ recipientId: STRANGER, serialNumber: 1 }] },
      [transfersOnly],
    );
    expect(outcome.ok).toBe(true);
  });

  it("rejects malformed payees at construction", () => {
    expect(() => new PayeeAllowlistPolicy({ payees: ["alice"] })).toThrow(/not an account ID/);
  });
});

describe("TimeWindowPolicy", () => {
  const weekdays = [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00" }];

  it("allows transactions inside the window, in the window's time zone", async () => {
    // 13:00 UTC on Wednesday 2026-10-21 is 08:00 in Bogotá (UTC-5).
    const time = clock("2026-10-21T13:00:00Z");
    const policy = new TimeWindowPolicy({
      timeZone: "America/Bogota",
      windows: weekdays,
      now: time.now,
    });
    expect(policy.isOpen()).toBe(true);
    time.set("2026-10-21T12:59:00Z");
    expect(policy.isOpen()).toBe(false);
    time.set("2026-10-22T00:59:00Z"); // 19:59 Wednesday in Bogotá
    expect(policy.isOpen()).toBe(true);
    time.set("2026-10-24T15:00:00Z"); // Saturday
    expect(policy.isOpen()).toBe(false);
  });

  it("refuses a transfer outside the window", async () => {
    const time = clock("2026-10-24T15:00:00Z");
    const policy = new TimeWindowPolicy({
      timeZone: "America/Bogota",
      windows: weekdays,
      now: time.now,
    });
    const outcome = await runTool(
      "transfer_hbar_tool",
      { transfers: [{ accountId: SHOP, amount: 1 }] },
      [policy],
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("it is 10:00 in America/Bogota");
  });

  it("restricts non-spending transaction tools too, but never queries", async () => {
    const time = clock("2026-10-24T15:00:00Z");
    const policy = new TimeWindowPolicy({
      timeZone: "America/Bogota",
      windows: weekdays,
      now: time.now,
    });
    const associate = await runTool(
      "associate_token_tool",
      { accountId: AGENT, tokenIds: [USDC] },
      [policy],
    );
    expect(associate.ok).toBe(false);
  });

  it("handles windows that run past midnight", () => {
    const time = clock("2026-10-21T04:00:00Z"); // 23:00 Tuesday in Bogotá
    const night = new TimeWindowPolicy({
      timeZone: "America/Bogota",
      windows: [{ days: [2], start: "22:00", end: "02:00" }],
      now: time.now,
    });
    expect(night.isOpen()).toBe(true);
    time.set("2026-10-21T06:30:00Z"); // 01:30 Wednesday, still Tuesday's window
    expect(night.isOpen()).toBe(true);
    time.set("2026-10-21T07:30:00Z"); // 02:30 Wednesday
    expect(night.isOpen()).toBe(false);
  });

  it("validates its config", () => {
    expect(() => new TimeWindowPolicy({ timeZone: "Mars/Olympus", windows: weekdays })).toThrow(
      /unknown time zone/,
    );
    expect(
      () => new TimeWindowPolicy({ timeZone: "UTC", windows: [{ start: "9:00", end: "25:00" }] }),
    ).toThrow(/24-hour time/);
  });
});
