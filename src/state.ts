import type { ScheduledApproval } from "./approval/scheduled-approval";
import type { DailySpendCapPolicy } from "./policies/daily-spend-cap";
import type { PayeeAllowlistPolicy } from "./policies/payee-allowlist";
import type { PerTxCapPolicy } from "./policies/per-tx-cap";
import type { TimeWindowPolicy } from "./policies/time-window";

/** The configured policies, as the plugin's query tools see them. */
export interface SpendPoliciesState {
  perTransaction?: PerTxCapPolicy;
  daily?: DailySpendCapPolicy;
  payees?: PayeeAllowlistPolicy;
  hours?: TimeWindowPolicy;
  approval?: ScheduledApproval;
}
