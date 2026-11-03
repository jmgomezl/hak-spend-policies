import type { AbstractHook, Plugin } from "@hashgraph/hedera-agent-kit";
import { RejectToolPolicy } from "@hashgraph/hedera-agent-kit/policies";
import { ScheduledApproval, type ScheduledApprovalOptions } from "./approval/scheduled-approval";
import { UNCOVERED_VALUE_TOOLS } from "./extract";
import { SpendLedger, type SpendStore } from "./ledger";
import { DailySpendCapPolicy, type SpendWindow } from "./policies/daily-spend-cap";
import { PayeeAllowlistPolicy } from "./policies/payee-allowlist";
import { PerTxCapPolicy } from "./policies/per-tx-cap";
import { type TimeWindow, TimeWindowPolicy } from "./policies/time-window";
import type { SpendPoliciesState } from "./state";
import { SpendApprovalStatusTool } from "./tools/approval-status";
import { SpendGetBudgetTool } from "./tools/budget";
import type { CapsConfig, SpendExtractor, SpendKind } from "./types";

export type EscalatingPolicy = "perTransaction" | "daily" | "payees" | "hours";

export interface SpendPoliciesConfig {
  /** Most a single call may move, per asset. */
  perTransaction?: CapsConfig;
  /** Most the agent may move per window, per asset. */
  daily?: CapsConfig;
  /** Window for `daily`. Default: rolling 24 hours. */
  dailyWindow?: SpendWindow;
  /** Accounts the agent may pay or grant allowances to. Omit to allow anyone. */
  payees?: string[];
  /** Which outflows the payee list applies to. Default: all. */
  payeeKinds?: SpendKind[];
  /** Hours the agent may transact in. Omit for any time. */
  hours?: { timeZone: string; windows: TimeWindow[] };
  /**
   * Owner approval for refused payments. Without it, refused payments are simply refused.
   * `escalate` picks which refusals become approval requests; default `["perTransaction", "daily"]`.
   */
  approval?: ScheduledApprovalOptions & { escalate?: EscalatingPolicy[] };
  /** A ledger, or a store to back a new one (e.g. `new FileSpendStore("spend.json")`). */
  ledger?: SpendLedger | SpendStore;
  /** Let assets with no cap through the caps. Default `false`: uncapped assets cannot move. */
  allowUnlistedAssets?: boolean;
  /** Extractors for third-party tools, keyed by tool method. */
  extractors?: Record<string, SpendExtractor>;
  /**
   * Refuse core tools that move value in ways these policies cannot measure (account deletion,
   * co-signing schedules, ERC-20/721 transfers). Default `true`. A tool you give an extractor
   * for is no longer refused.
   */
  rejectUncovered?: boolean;
  now?: () => Date;
}

export interface SpendPolicies extends SpendPoliciesState {
  /** Pass as `context.hooks` (or spread into your own list). Order matters and is set for you. */
  hooks: AbstractHook[];
  /** Adds `spend_get_budget` and `spend_approval_status` so the model can see its limits. */
  plugin: Plugin;
  ledger: SpendLedger;
}

/**
 * Builds the full set of spend policies from one config, in the order they should run:
 * uncovered tools refused, then hours, payees, per-transaction cap and, last, the daily cap,
 * which reserves budget only once everything before it has passed.
 *
 * ```ts
 * const spend = spendPolicies({
 *   perTransaction: { HBAR: 5 },
 *   daily: { HBAR: 20, "0.0.456858": { amount: 50, decimals: 6 } },
 *   payees: ["0.0.800", "0.0.4812"],
 *   hours: { timeZone: "America/Bogota", windows: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00" }] },
 *   approval: { ownerAccountId: "0.0.1234" },
 *   ledger: new FileSpendStore("./spend-ledger.json"),
 * });
 * const toolkit = new HederaLangchainToolkit({
 *   client,
 *   configuration: { plugins: [coreAccountPlugin, spend.plugin], context: { hooks: spend.hooks } },
 * });
 * ```
 */
export function spendPolicies(config: SpendPoliciesConfig): SpendPolicies {
  const ledger =
    config.ledger instanceof SpendLedger
      ? config.ledger
      : new SpendLedger({
          store: config.ledger,
          now: config.now ? () => (config.now as () => Date)().getTime() : undefined,
        });

  const approval = config.approval
    ? new ScheduledApproval({ now: config.now, ...config.approval })
    : undefined;
  const escalate = new Set<EscalatingPolicy>(
    config.approval?.escalate ?? ["perTransaction", "daily"],
  );
  const approvalFor = (policy: EscalatingPolicy) => (escalate.has(policy) ? approval : undefined);
  const shared = { extractors: config.extractors, now: config.now };

  const state: SpendPoliciesState = { approval };
  const hooks: AbstractHook[] = [];

  if (config.rejectUncovered ?? true) {
    const uncovered = UNCOVERED_VALUE_TOOLS.filter((tool) => !config.extractors?.[tool]);
    if (uncovered.length > 0) hooks.push(new RejectToolPolicy(uncovered));
  }
  if (config.hours) {
    state.hours = new TimeWindowPolicy({
      ...shared,
      ...config.hours,
      approval: approvalFor("hours"),
    });
    hooks.push(state.hours);
  }
  if (config.payees) {
    state.payees = new PayeeAllowlistPolicy({
      ...shared,
      payees: config.payees,
      kinds: config.payeeKinds,
      approval: approvalFor("payees"),
    });
    hooks.push(state.payees);
  }
  if (config.perTransaction) {
    state.perTransaction = new PerTxCapPolicy({
      ...shared,
      caps: config.perTransaction,
      allowUnlistedAssets: config.allowUnlistedAssets,
      approval: approvalFor("perTransaction"),
    });
    hooks.push(state.perTransaction);
  }
  if (config.daily) {
    state.daily = new DailySpendCapPolicy({
      ...shared,
      caps: config.daily,
      ledger,
      window: config.dailyWindow,
      allowUnlistedAssets: config.allowUnlistedAssets,
      approval: approvalFor("daily"),
    });
    hooks.push(state.daily);
  }

  const plugin: Plugin = {
    name: "spend-policies",
    version: "0.1.0",
    description:
      "Lets the agent read its own spending limits and check whether the owner approved a " +
      "payment that went over them.",
    tools: () => [new SpendGetBudgetTool(state), new SpendApprovalStatusTool(state)],
  };

  return { ...state, hooks, plugin, ledger };
}
