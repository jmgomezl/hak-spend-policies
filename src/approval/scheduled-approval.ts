import {
  AccountId,
  type Client,
  Hbar,
  type Key,
  ReceiptStatusError,
  ScheduleCreateTransaction,
  Status,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { describeAmount, totalsByAsset } from "../caps";
import type { SpendIntent } from "../types";
import { HBAR } from "../units";

/** Hedera's longest allowed schedule lifetime (62 days, HIP-423). */
export const MAX_APPROVAL_SECONDS = 62 * 24 * 3_600;

/** Default time the owner has to approve: 24 hours. */
export const DEFAULT_APPROVAL_SECONDS = 24 * 3_600;

const MEMO_MAX_BYTES = 100;

export interface ApprovalRequest {
  scheduleId: string;
  transactionId: string;
  /** The account the scheduled transfer debits. Only its key can approve. */
  ownerAccountId: string;
  method: string;
  reason: string;
  /** Outflows in base units, as decimal strings. */
  items: { asset: string; amount: string; to: string }[];
  expiresAt: string;
  /** True when this call matched an approval already pending and no new schedule was created. */
  reused: boolean;
}

export interface ScheduledApprovalOptions {
  /**
   * The account the approved payment is debited from. Its key must not be one the agent holds,
   * otherwise the agent could sign its own approvals. In the Agent Accounts model this is the
   * owner wallet that funds the agent.
   */
  ownerAccountId: string;
  /** How long the owner has to sign. Default 24 hours, at most 62 days. */
  expiresInSeconds?: number;
  /** Optional key that can delete (reject) the pending schedule. */
  adminKey?: Key;
  /** Memo prefix shown in wallets and on HashScan. Default `"agent payment approval"`. */
  memoPrefix?: string;
  /** Called after a schedule is created, e.g. to message the owner on Telegram. */
  onRequested?: (request: ApprovalRequest) => void | Promise<void>;
  /**
   * Submits the schedule. Defaults to executing it with the agent's client and reading the
   * receipt. Override it for tests or to route through your own signer.
   */
  submit?: (
    transaction: ScheduleCreateTransaction,
    client: Client,
  ) => Promise<{ scheduleId: string; transactionId: string }>;
  now?: () => Date;
}

/**
 * Turns a payment a policy refused into a native Hedera approval step.
 *
 * Instead of sending the payment, the agent creates a Scheduled Transaction that pays the same
 * recipients from `ownerAccountId`. The agent pays the small creation fee; the network executes
 * the transfer the moment the owner adds their signature (from any wallet or with
 * `npm run approve`), and lets it lapse if they never do. No contract and no backend sit in
 * between, and the agent cannot complete the approval itself because it does not hold the
 * owner's key.
 */
export class ScheduledApproval {
  readonly ownerAccountId: string;
  private readonly expiresInSeconds: number;
  private readonly options: ScheduledApprovalOptions;
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(options: ScheduledApprovalOptions) {
    this.ownerAccountId = AccountId.fromString(options.ownerAccountId).toString();
    const seconds = options.expiresInSeconds ?? DEFAULT_APPROVAL_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_APPROVAL_SECONDS) {
      throw new Error(
        `ScheduledApproval: expiresInSeconds must be an integer from 60 to ${MAX_APPROVAL_SECONDS}`,
      );
    }
    this.expiresInSeconds = seconds;
    this.options = options;
  }

  /** Only fungible transfers can be re-issued from the owner's account. */
  canEscalate(intent: SpendIntent): boolean {
    return intent.items.length > 0 && intent.items.every((item) => item.kind === "transfer");
  }

  /** Approvals created by this instance that have not expired yet. */
  pendingRequests(): ApprovalRequest[] {
    this.dropExpired();
    return [...this.pending.values()];
  }

  /**
   * The transfer the owner is asked to approve: the same recipients and amounts as the refused
   * call, debited from the owner instead of the agent.
   */
  buildTransfer(intent: SpendIntent): TransferTransaction {
    if (!this.canEscalate(intent)) {
      throw new Error("ScheduledApproval: only HBAR and fungible token transfers can be approved");
    }
    const transfer = new TransferTransaction();
    for (const item of intent.items) {
      if (item.asset === HBAR) {
        transfer.addHbarTransfer(item.to, Hbar.fromTinybars(item.amount.toString()));
      } else {
        transfer.addTokenTransfer(item.asset, item.to, item.amount);
      }
    }
    for (const [asset, total] of totalsByAsset(intent.items)) {
      if (asset === HBAR) {
        transfer.addHbarTransfer(this.ownerAccountId, Hbar.fromTinybars((-total).toString()));
      } else {
        transfer.addTokenTransfer(asset, this.ownerAccountId, -total);
      }
    }
    return transfer;
  }

  /** Builds the unsigned schedule for an intent. Exposed so tests and dry runs can inspect it. */
  buildSchedule(intent: SpendIntent): ScheduleCreateTransaction {
    const expiresAt = new Date(this.now().getTime() + this.expiresInSeconds * 1_000);
    const schedule = new ScheduleCreateTransaction()
      .setScheduledTransaction(this.buildTransfer(intent))
      .setScheduleMemo(this.memo(intent))
      .setExpirationTime(Timestamp.fromDate(expiresAt))
      .setWaitForExpiry(false);
    if (this.options.adminKey) schedule.setAdminKey(this.options.adminKey);
    return schedule;
  }

  /**
   * Creates (or reuses) the approval schedule for an intent. A model that retries a refused
   * payment gets the same pending schedule back instead of piling up duplicates.
   */
  async request(intent: SpendIntent, reason: string, client: Client): Promise<ApprovalRequest> {
    const operator = client.operatorAccountId?.toString();
    if (operator === this.ownerAccountId) {
      throw new Error(
        `ScheduledApproval: the owner ${this.ownerAccountId} is also the agent's operator, so the agent could approve its own payments. Use a separate owner account.`,
      );
    }

    const key = this.keyOf(intent);
    this.dropExpired();
    const existing = this.pending.get(key);
    if (existing) return { ...existing, reused: true };

    const schedule = this.buildSchedule(intent);
    const { scheduleId, transactionId } = await (this.options.submit ?? submitSchedule)(
      schedule,
      client,
    );
    const request: ApprovalRequest = {
      scheduleId,
      transactionId,
      ownerAccountId: this.ownerAccountId,
      method: intent.method,
      reason,
      items: intent.items.map((item) => ({
        asset: item.asset,
        amount: item.amount.toString(),
        to: item.to,
      })),
      expiresAt: schedule.expirationTime?.toDate().toISOString() ?? "",
      reused: false,
    };
    this.pending.set(key, request);

    if (this.options.onRequested) {
      try {
        await this.options.onRequested(request);
      } catch (error) {
        console.warn("ScheduledApproval: onRequested callback failed", error);
      }
    }
    return request;
  }

  /** Forgets a pending approval, e.g. after it executed, so the same payment can be requested again. */
  forget(scheduleId: string): void {
    for (const [key, request] of this.pending) {
      if (request.scheduleId === scheduleId) this.pending.delete(key);
    }
  }

  private memo(intent: SpendIntent): string {
    const parts = [...totalsByAsset(intent.items)].map(([asset, amount]) =>
      describeAmount(asset, amount),
    );
    const recipients = [...new Set(intent.items.map((item) => item.to))].join(",");
    const memo = `${this.options.memoPrefix ?? "agent payment approval"}: ${parts.join(" + ")} to ${recipients}`;
    return truncateUtf8(memo, MEMO_MAX_BYTES);
  }

  private keyOf(intent: SpendIntent): string {
    const items = intent.items
      .map((item) => `${item.asset}:${item.to}:${item.amount}`)
      .sort()
      .join("|");
    return `${intent.method}|${items}`;
  }

  private dropExpired(): void {
    const now = this.now().getTime();
    for (const [key, request] of this.pending) {
      if (Date.parse(request.expiresAt) <= now) this.pending.delete(key);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

async function submitSchedule(
  transaction: ScheduleCreateTransaction,
  client: Client,
): Promise<{ scheduleId: string; transactionId: string }> {
  const response = await transaction.execute(client);
  const transactionId = response.transactionId.toString();
  try {
    const receipt = await response.getReceipt(client);
    if (!receipt.scheduleId) throw new Error("schedule receipt carried no schedule ID");
    return { scheduleId: receipt.scheduleId.toString(), transactionId };
  } catch (error) {
    // The network refuses a second identical schedule but names the existing one.
    if (
      error instanceof ReceiptStatusError &&
      error.status === Status.IdenticalScheduleAlreadyCreated &&
      error.transactionReceipt.scheduleId
    ) {
      return { scheduleId: error.transactionReceipt.scheduleId.toString(), transactionId };
    }
    throw error;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let result = text;
  while (encoder.encode(`${result}…`).length > maxBytes) result = result.slice(0, -1);
  return `${result}…`;
}
