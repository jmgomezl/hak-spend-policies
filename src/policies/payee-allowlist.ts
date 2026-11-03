import type { PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import { idOf } from "../extract";
import type { SpendKind } from "../types";
import { SpendPolicy, type SpendPolicyOptions } from "./base";

const ALL_KINDS: SpendKind[] = ["transfer", "allowance", "nft", "nft-allowance"];
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export interface PayeeAllowlistOptions extends SpendPolicyOptions {
  /** Account IDs (`0.0.x`) or EVM addresses the agent may pay or grant allowances to. */
  payees: string[];
  /** Which outflows the list applies to. Default: all, including allowances and NFTs. */
  kinds?: SpendKind[];
}

/**
 * Only lets value go to approved accounts. Allowance approvals are checked too, because an
 * allowance is a way to let an unapproved account take the funds later.
 *
 * Accounts are matched by ID or by EVM address as written. An account referenced by its alias
 * in one place and its ID in another is not matched across the two, so list both if the agent
 * may use either.
 */
export class PayeeAllowlistPolicy extends SpendPolicy {
  name = "Payee Allowlist";
  description: string;
  private readonly payees: Set<string>;
  private readonly kinds: Set<SpendKind>;

  constructor(options: PayeeAllowlistOptions) {
    super(options);
    this.payees = new Set(
      options.payees.map((payee) => {
        const id = idOf(payee);
        if (!ACCOUNT_ID.test(id) && !EVM_ADDRESS.test(id)) {
          throw new Error(`PayeeAllowlistPolicy: "${payee}" is not an account ID or EVM address`);
        }
        return id;
      }),
    );
    this.kinds = new Set(options.kinds ?? ALL_KINDS);
    this.description = `Only pays ${[...this.payees].join(", ") || "nobody"}`;
  }

  allowed(): string[] {
    return [...this.payees];
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    const intent = this.intentOf(params, method);
    const outsiders = [
      ...new Set(
        intent.items
          .filter((item) => this.kinds.has(item.kind) && !this.payees.has(item.to))
          .map((item) => item.to),
      ),
    ];
    if (outsiders.length > 0) {
      return this.refuse(
        `${outsiders.join(", ")} ${outsiders.length === 1 ? "is" : "are"} not on the payee allowlist`,
        intent,
        params.client,
      );
    }
    return false;
  }
}
