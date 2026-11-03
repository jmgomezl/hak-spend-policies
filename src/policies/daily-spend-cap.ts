import {
  type PostParamsNormalizationParams,
  type PostSecondaryActionParams,
  TOOL_STATUS,
} from "@hashgraph/hedera-agent-kit";
import { describeAmount, resolveCaps, totalsByAsset } from "../caps";
import { SpendLedger } from "../ledger";
import { assertTimeZone, startOfZonedDay } from "../time";
import type { CapsConfig, ResolvedCap } from "../types";
import { SpendPolicy, type SpendPolicyOptions } from "./base";

/**
 * The period a daily cap covers.
 *
 * - `rolling` (default, 24 hours): the last N hours, so there is no midnight reset to time a
 *   burst around.
 * - `calendar`: since local midnight in `timeZone`, like a bank card's daily limit.
 */
export type SpendWindow =
  | { type: "rolling"; hours?: number }
  | { type: "calendar"; timeZone: string };

export interface DailySpendCapOptions extends SpendPolicyOptions {
  /** Most the agent may move per window, per asset. */
  caps: CapsConfig;
  /** Share one ledger between policies or persist it with a `FileSpendStore`. */
  ledger?: SpendLedger;
  window?: SpendWindow;
  /** Let assets with no cap through. Default `false`. */
  allowUnlistedAssets?: boolean;
  now?: () => Date;
}

export interface BudgetLine {
  asset: string;
  decimals: number;
  limit: bigint;
  spent: bigint;
  remaining: bigint;
}

/**
 * Caps what the agent can move within a window (24 hours by default).
 *
 * Budget is reserved when a call passes and committed when the tool reports success, so
 * parallel calls cannot each squeeze under the same remaining budget, and a failed transaction
 * gives its budget back. Put this policy last in `hooks`: a reservation made before another
 * policy refuses the call is held until it lapses (2 minutes by default).
 *
 * In `RETURN_BYTES` mode "success" means the bytes were handed to the signer, so a payment the
 * user then declines to sign still counts. That errs on the side of spending less.
 */
export class DailySpendCapPolicy extends SpendPolicy {
  name = "Daily Spend Cap";
  description: string;
  readonly ledger: SpendLedger;
  private readonly caps: Map<string, ResolvedCap>;
  private readonly window: SpendWindow;
  private readonly allowUnlisted: boolean;
  private readonly now: () => Date;
  private readonly inFlight = new WeakMap<object, string>();

  constructor(options: DailySpendCapOptions) {
    super(options);
    this.caps = resolveCaps(options.caps, "DailySpendCapPolicy");
    this.ledger = options.ledger ?? new SpendLedger();
    this.window = options.window ?? { type: "rolling", hours: 24 };
    if (this.window.type === "calendar") {
      assertTimeZone(this.window.timeZone, "DailySpendCapPolicy");
    } else if (this.window.hours !== undefined && !(this.window.hours > 0)) {
      throw new Error("DailySpendCapPolicy: rolling window hours must be positive");
    }
    this.allowUnlisted = options.allowUnlistedAssets ?? false;
    this.now = options.now ?? (() => new Date());
    const listed = [...this.caps].map(([asset, cap]) =>
      describeAmount(asset, cap.limit, cap.decimals),
    );
    this.description = `At most ${listed.join(", ") || "nothing"} per ${this.windowLabel()}`;
  }

  /** Epoch milliseconds where the current window starts. */
  windowStart(): number {
    const now = this.now();
    if (this.window.type === "calendar") return startOfZonedDay(now, this.window.timeZone);
    return now.getTime() - (this.window.hours ?? 24) * 3_600_000;
  }

  /** `"24 hours"` or `"day (America/Bogota)"`. */
  windowLabel(): string {
    return this.window.type === "calendar"
      ? `day (${this.window.timeZone})`
      : `${this.window.hours ?? 24} hours`;
  }

  private windowPhrase(): string {
    return this.window.type === "calendar"
      ? `today in ${this.window.timeZone}`
      : `in the last ${this.window.hours ?? 24} hours`;
  }

  /** Limit, spend so far and what is left in the current window, per capped asset. */
  budget(): BudgetLine[] {
    const since = this.windowStart();
    return [...this.caps].map(([asset, cap]) => {
      const spent = this.ledger.spentSince(asset, since);
      const remaining = cap.limit > spent ? cap.limit - spent : 0n;
      return { asset, decimals: cap.decimals, limit: cap.limit, spent, remaining };
    });
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    const intent = this.intentOf(params, method);
    const totals = totalsByAsset(intent.items);
    const since = this.windowStart();
    const tracked = new Map<string, bigint>();

    for (const [asset, amount] of totals) {
      const cap = this.caps.get(asset);
      if (!cap) {
        if (this.allowUnlisted) continue;
        return this.refuse(
          `${describeAmount(asset, amount)} was refused: ${asset} has no daily cap, so the agent may not move it`,
          intent,
          params.client,
        );
      }
      const spent = this.ledger.spentSince(asset, since);
      if (spent + amount > cap.limit) {
        const show = (value: bigint) => describeAmount(asset, value, cap.decimals);
        return this.refuse(
          `${show(amount)} would bring spending ${this.windowPhrase()} to ` +
            `${show(spent + amount)}, over the cap of ${show(cap.limit)} ` +
            `(${show(spent)} already spent, ${show(cap.limit > spent ? cap.limit - spent : 0n)} left)`,
          intent,
          params.client,
        );
      }
      tracked.set(asset, amount);
    }

    const key = params.normalisedParams;
    if (tracked.size > 0 && key && typeof key === "object") {
      this.inFlight.set(key, this.ledger.reserve(tracked, method));
    }
    return false;
  }

  override async postToolExecutionHook(
    params: PostSecondaryActionParams,
    method: string,
  ): Promise<void> {
    await super.postToolExecutionHook(params, method);
    const key = params.normalisedParams;
    if (!key || typeof key !== "object") return;
    const reservation = this.inFlight.get(key);
    if (!reservation) return;
    this.inFlight.delete(key);
    if (params.toolResult?.raw?.status === TOOL_STATUS.ERROR) this.ledger.release(reservation);
    else this.ledger.commit(reservation);
  }
}
