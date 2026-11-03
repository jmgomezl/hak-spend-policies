export { spendPolicies } from "./spend-policies";
export type { EscalatingPolicy, SpendPolicies, SpendPoliciesConfig } from "./spend-policies";

export { SpendPolicy } from "./policies/base";
export type { SpendPolicyOptions } from "./policies/base";
export { PerTxCapPolicy } from "./policies/per-tx-cap";
export type { PerTxCapOptions } from "./policies/per-tx-cap";
export { DailySpendCapPolicy } from "./policies/daily-spend-cap";
export type { BudgetLine, DailySpendCapOptions, SpendWindow } from "./policies/daily-spend-cap";
export { PayeeAllowlistPolicy } from "./policies/payee-allowlist";
export type { PayeeAllowlistOptions } from "./policies/payee-allowlist";
export { TimeWindowPolicy } from "./policies/time-window";
export type { TimeWindow, TimeWindowOptions } from "./policies/time-window";

export {
  DEFAULT_APPROVAL_SECONDS,
  MAX_APPROVAL_SECONDS,
  ScheduledApproval,
} from "./approval/scheduled-approval";
export type { ApprovalRequest, ScheduledApprovalOptions } from "./approval/scheduled-approval";

export { FileSpendStore, MemorySpendStore, SpendLedger } from "./ledger";
export type { SpendLedgerOptions, SpendRecord, SpendStore } from "./ledger";

export { SpendPolicyViolation } from "./errors";
export { UNCOVERED_VALUE_TOOLS, builtinExtractors, extractIntent, idOf } from "./extract";
export { HBAR, formatUnits, toBaseUnits } from "./units";
export type {
  CapValue,
  CapsConfig,
  ResolvedCap,
  SpendExtractor,
  SpendIntent,
  SpendItem,
  SpendKind,
} from "./types";

export { SPEND_APPROVAL_STATUS_TOOL, SpendApprovalStatusTool } from "./tools/approval-status";
export type { ApprovalState } from "./tools/approval-status";
export { SPEND_GET_BUDGET_TOOL, SpendGetBudgetTool } from "./tools/budget";

export const spendPolicyToolNames = {
  SPEND_GET_BUDGET_TOOL: "spend_get_budget",
  SPEND_APPROVAL_STATUS_TOOL: "spend_approval_status",
} as const;
