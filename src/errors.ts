import type { ApprovalRequest } from "./approval/scheduled-approval";

/**
 * Thrown by every spend policy when it stops a tool call. The Agent Kit turns it into the tool's
 * error result, so `message` is what the model reads: it says why, and, when an approval was
 * requested, which schedule the owner has to sign.
 */
export class SpendPolicyViolation extends Error {
  readonly policy: string;
  readonly reason: string;
  readonly approval?: ApprovalRequest;

  constructor(policy: string, reason: string, approval?: ApprovalRequest, approvalError?: string) {
    super(buildMessage(policy, reason, approval, approvalError));
    this.name = "SpendPolicyViolation";
    this.policy = policy;
    this.reason = reason;
    this.approval = approval;
  }
}

function buildMessage(
  policy: string,
  reason: string,
  approval?: ApprovalRequest,
  approvalError?: string,
): string {
  const head = `[${policy}] ${reason}.`;
  if (approval) {
    return (
      `${head} The payment was NOT sent. Owner approval was requested instead: scheduled ` +
      `transaction ${approval.scheduleId} will pay it from ${approval.ownerAccountId} as soon as ` +
      `that account signs it (expires ${approval.expiresAt}). Do not retry the payment; tell the ` +
      `user to approve schedule ${approval.scheduleId}.`
    );
  }
  if (approvalError) {
    return `${head} The transaction was NOT submitted, and the owner approval request failed: ${approvalError}`;
  }
  return `${head} The transaction was NOT submitted. Do not retry it.`;
}
