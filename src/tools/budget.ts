import { BaseQueryTool, type Context, untypedQueryOutputParser } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { z } from "zod";
import { describeAmount } from "../caps";
import type { SpendPoliciesState } from "../state";

const budgetInputSchema = z.object({});

type BudgetInput = z.infer<typeof budgetInputSchema>;

export const SPEND_GET_BUDGET_TOOL = "spend_get_budget";

/**
 * Lets the model see its limits before it tries a payment, so it can plan around them or ask for
 * approval up front instead of learning the cap from a refusal.
 */
export class SpendGetBudgetTool extends BaseQueryTool {
  method = SPEND_GET_BUDGET_TOOL;
  name = "Get Spending Budget";
  description =
    "Show this agent's spending limits: the per-transaction cap, how much of the daily cap is " +
    "spent and left, which payees are allowed, whether payments are allowed right now, and any " +
    "payments waiting for the owner's approval. Call it before a payment you are unsure about.";
  parameters = budgetInputSchema;
  override outputParser = untypedQueryOutputParser;

  constructor(private readonly state: SpendPoliciesState) {
    super();
  }

  async normalizeParams(params: BudgetInput, _context: Context, _client: Client) {
    return budgetInputSchema.parse(params ?? {});
  }

  async coreAction(_args: BudgetInput, _context: Context, _client: Client) {
    const { perTransaction, daily, payees, hours, approval } = this.state;
    const lines: string[] = [];

    const perTx = perTransaction
      ? [...perTransaction.limits()].map(([asset, cap]) => ({
          asset,
          limit: describeAmount(asset, cap.limit, cap.decimals),
        }))
      : null;
    if (perTx) lines.push(`Per transaction: ${perTx.map((cap) => cap.limit).join(", ")}`);

    const dailyLines = daily
      ? daily.budget().map((line) => {
          const show = (value: bigint) => describeAmount(line.asset, value, line.decimals);
          return {
            asset: line.asset,
            limit: show(line.limit),
            spent: show(line.spent),
            remaining: show(line.remaining),
          };
        })
      : null;
    if (daily && dailyLines) {
      lines.push(
        `Per ${daily.windowLabel()}: ${dailyLines
          .map((line) => `${line.remaining} left of ${line.limit}`)
          .join("; ")}`,
      );
    }

    const allowed = payees?.allowed() ?? null;
    if (allowed) lines.push(`Allowed payees: ${allowed.join(", ")}`);

    const open = hours ? hours.isOpen() : null;
    if (hours) lines.push(`${open ? "Inside" : "Outside"} allowed hours (${hours.description})`);

    const pending = approval?.pendingRequests() ?? [];
    if (approval) {
      lines.push(
        pending.length > 0
          ? `Waiting for owner approval: ${pending.map((p) => p.scheduleId).join(", ")}`
          : `Payments over the limits go to ${approval.ownerAccountId} for approval`,
      );
    }

    return {
      raw: {
        perTransaction: perTx,
        daily: daily ? { window: daily.windowLabel(), assets: dailyLines } : null,
        payees: allowed,
        hours: hours ? { open, rule: hours.description } : null,
        approval: approval
          ? {
              ownerAccountId: approval.ownerAccountId,
              pending: pending.map(({ reused, ...p }) => p),
            }
          : null,
      },
      humanMessage: lines.length > 0 ? lines.join("\n") : "No spending policies are configured.",
    };
  }

  override async shouldSecondaryAction(_result: unknown, _context: Context) {
    return false;
  }
}
