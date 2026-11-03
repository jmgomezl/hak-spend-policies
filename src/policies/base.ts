import { AbstractPolicy, type PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import type { ScheduledApproval } from "../approval/scheduled-approval";
import { SpendPolicyViolation } from "../errors";
import { builtinExtractors, extractIntent } from "../extract";
import type { SpendExtractor, SpendIntent } from "../types";

export interface SpendPolicyOptions {
  /** Extra or replacement extractors, keyed by tool method. Each one extends `relevantTools`. */
  extractors?: Record<string, SpendExtractor>;
  /**
   * When set, a payment this policy refuses becomes an owner-approval Scheduled Transaction
   * instead of a plain refusal. Only HBAR and fungible token transfers can be escalated.
   */
  approval?: ScheduledApproval;
}

/**
 * Shared plumbing for the spend policies: turning a tool call into outflows, and refusing it,
 * optionally by asking the owner to approve it on-chain.
 *
 * Policies refuse by throwing {@link SpendPolicyViolation} rather than returning `true`, so the
 * model gets a specific reason (and the schedule ID to approve) instead of a generic block.
 */
export abstract class SpendPolicy extends AbstractPolicy {
  relevantTools: string[];
  protected readonly extractors: Readonly<Record<string, SpendExtractor>>;
  protected readonly approval?: ScheduledApproval;

  constructor(options: SpendPolicyOptions = {}) {
    super();
    this.extractors = { ...builtinExtractors, ...options.extractors };
    this.relevantTools = Object.keys(this.extractors);
    this.approval = options.approval;
  }

  protected intentOf(params: PostParamsNormalizationParams, method: string): SpendIntent {
    return extractIntent(
      method,
      params.normalisedParams,
      params.rawParams,
      this.extractors,
      this.name,
    );
  }

  /** Stops the call. With an approval configured, first creates the owner-approval schedule. */
  protected async refuse(
    reason: string,
    intent: SpendIntent | null,
    client: Client,
  ): Promise<never> {
    if (!this.approval || !intent || !this.approval.canEscalate(intent)) {
      throw new SpendPolicyViolation(this.name, reason);
    }
    let request: Awaited<ReturnType<ScheduledApproval["request"]>>;
    try {
      request = await this.approval.request(intent, reason, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SpendPolicyViolation(this.name, reason, undefined, message);
    }
    throw new SpendPolicyViolation(this.name, reason, request);
  }
}
