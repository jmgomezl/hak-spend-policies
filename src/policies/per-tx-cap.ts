import type { PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import { describeAmount, resolveCaps, totalsByAsset } from "../caps";
import type { CapsConfig, ResolvedCap } from "../types";
import { SpendPolicy, type SpendPolicyOptions } from "./base";

export interface PerTxCapOptions extends SpendPolicyOptions {
  /** Most each single tool call may move, per asset. `{ HBAR: 5, "0.0.456858": { amount: 20, decimals: 6 } }` */
  caps: CapsConfig;
  /** Let assets with no cap through. Default `false`: an asset with no cap cannot be moved. */
  allowUnlistedAssets?: boolean;
}

/**
 * Caps what a single tool call can move. A call that pays several recipients is measured by
 * its total, so splitting a payment across recipients does not get around the cap. Allowance
 * approvals count too: granting someone the right to pull 100 HBAR is a 100 HBAR exposure.
 */
export class PerTxCapPolicy extends SpendPolicy {
  name = "Per-Transaction Cap";
  description: string;
  private readonly caps: Map<string, ResolvedCap>;
  private readonly allowUnlisted: boolean;

  constructor(options: PerTxCapOptions) {
    super(options);
    this.caps = resolveCaps(options.caps, "PerTxCapPolicy");
    this.allowUnlisted = options.allowUnlistedAssets ?? false;
    const listed = [...this.caps].map(([asset, cap]) =>
      describeAmount(asset, cap.limit, cap.decimals),
    );
    this.description = `At most ${listed.join(", ") || "nothing"} per transaction`;
  }

  limits(): ReadonlyMap<string, ResolvedCap> {
    return this.caps;
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    const intent = this.intentOf(params, method);
    for (const [asset, amount] of totalsByAsset(intent.items)) {
      const cap = this.caps.get(asset);
      if (!cap) {
        if (this.allowUnlisted) continue;
        return this.refuse(
          `${describeAmount(asset, amount)} was refused: ${asset} has no per-transaction cap, so the agent may not move it`,
          intent,
          params.client,
        );
      }
      if (amount > cap.limit) {
        return this.refuse(
          `${describeAmount(asset, amount, cap.decimals)} is over the per-transaction cap of ${describeAmount(asset, cap.limit, cap.decimals)}`,
          intent,
          params.client,
        );
      }
    }
    return false;
  }
}
