import {
  BaseQueryTool,
  type Context,
  getMirrornodeService,
  untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { z } from "zod";
import type { SpendPoliciesState } from "../state";

const statusInputSchema = z.object({
  scheduleId: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "Schedule IDs look like 0.0.12345")
    .describe("Schedule ID of the approval request, as given in the refusal message"),
});

type StatusInput = z.infer<typeof statusInputSchema>;

export const SPEND_APPROVAL_STATUS_TOOL = "spend_approval_status";

export type ApprovalState = "approved" | "pending" | "expired" | "rejected";

/** Mirror node timestamps are `seconds.nanoseconds`. */
function timestampToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const seconds = Number(value.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000) : null;
}

/**
 * Reports whether the owner approved an escalated payment. Reads the mirror node, so it costs
 * nothing and works in every agent mode.
 */
export class SpendApprovalStatusTool extends BaseQueryTool {
  method = SPEND_APPROVAL_STATUS_TOOL;
  name = "Get Payment Approval Status";
  description =
    "Check whether the owner has approved a payment that went to them for approval. Returns " +
    "approved (the payment executed), pending, expired or rejected. Use the schedule ID from " +
    "the refusal message. Do not resend the payment yourself: an approved schedule already paid.";
  parameters = statusInputSchema;
  override outputParser = untypedQueryOutputParser;

  constructor(private readonly state: SpendPoliciesState) {
    super();
  }

  async normalizeParams(params: StatusInput, _context: Context, _client: Client) {
    return statusInputSchema.parse(params);
  }

  async coreAction(args: StatusInput, context: Context, client: Client) {
    if (!client.ledgerId) {
      throw new Error(
        "The client has no ledger ID; create it with Client.forTestnet() or forMainnet()",
      );
    }
    const mirror = getMirrornodeService(context.mirrornodeService, client.ledgerId);
    const details = await mirror.getScheduledTransactionDetails(args.scheduleId);

    const executedAt = timestampToDate(details.executed_timestamp);
    const expiresAt = timestampToDate(details.expiration_time);
    let state: ApprovalState = "pending";
    if (executedAt) state = "approved";
    else if (details.deleted) state = "rejected";
    else if (expiresAt && expiresAt.getTime() <= Date.now()) state = "expired";

    if (state !== "pending") this.state.approval?.forget(args.scheduleId);

    const messages: Record<ApprovalState, string> = {
      approved: `Schedule ${args.scheduleId} was approved and the payment executed at ${executedAt?.toISOString()}.`,
      pending: `Schedule ${args.scheduleId} is still waiting for the owner's signature${
        expiresAt ? ` (expires ${expiresAt.toISOString()})` : ""
      }.`,
      expired: `Schedule ${args.scheduleId} expired without approval. The payment was not made.`,
      rejected: `Schedule ${args.scheduleId} was deleted, so the owner rejected the payment.`,
    };

    return {
      raw: {
        scheduleId: args.scheduleId,
        state,
        executedAt: executedAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        signatureCount: details.signatures?.length ?? 0,
        memo: details.memo,
      },
      humanMessage: messages[state],
    };
  }

  override async shouldSecondaryAction(_result: unknown, _context: Context) {
    return false;
  }
}
