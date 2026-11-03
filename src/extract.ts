import {
  coreAccountPluginToolNames as account,
  coreEVMPluginToolNames as evm,
  coreTokenPluginToolNames as token,
} from "@hashgraph/hedera-agent-kit/plugins";
import type { SpendExtractor, SpendIntent, SpendItem } from "./types";
import { HBAR, toBigInt } from "./units";

/** Normalises an account or token ID to its plain string form (no checksum, EVM lower case). */
export function idOf(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase();
  return text.replace(/-[a-z]{5}$/, "");
}

type Bag = Record<string, unknown>;

/**
 * Reads `params[key]` as a list of records. A missing field fails closed: if a future Agent Kit
 * renamed it, reading it as "no outflows" would wave every payment through.
 */
function listOf(params: unknown, key: string): Bag[] {
  const value = (params as Bag | null | undefined)?.[key];
  if (!Array.isArray(value)) {
    throw new Error(
      `Spend policy could not find '${key}' in the tool's normalised parameters, so it cannot measure this call and refuses it. The Agent Kit version may have changed its shape.`,
    );
  }
  return value as Bag[];
}

const positive = (item: SpendItem) => item.amount > 0n;

const hbarTransfers: SpendExtractor = (p) =>
  listOf(p, "hbarTransfers")
    .map(
      (t): SpendItem => ({
        asset: HBAR,
        amount: toBigInt(t.amount),
        to: idOf(t.accountId),
        kind: "transfer",
      }),
    )
    .filter(positive);

const tokenTransfers: SpendExtractor = (p) =>
  listOf(p, "tokenTransfers")
    .map(
      (t): SpendItem => ({
        asset: idOf(t.tokenId),
        amount: toBigInt(t.amount),
        to: idOf(t.accountId),
        kind: "transfer",
      }),
    )
    .filter(positive);

const hbarApprovals: SpendExtractor = (p) =>
  listOf(p, "hbarApprovals")
    .map(
      (a): SpendItem => ({
        asset: HBAR,
        amount: toBigInt(a.amount ?? 0),
        to: idOf(a.spenderAccountId),
        kind: "allowance",
      }),
    )
    .filter(positive);

const tokenApprovals: SpendExtractor = (p) =>
  listOf(p, "tokenApprovals")
    .map(
      (a): SpendItem => ({
        asset: idOf(a.tokenId),
        amount: toBigInt(a.amount ?? 0),
        to: idOf(a.spenderAccountId),
        kind: "allowance",
      }),
    )
    .filter(positive);

const nftTransfers: SpendExtractor = (p) =>
  listOf(p, "transfers").map(
    (t): SpendItem => ({
      asset: idOf((t.nftId as Bag | undefined)?.tokenId),
      amount: 1n,
      to: idOf(t.receiver),
      kind: "nft",
    }),
  );

const nftApprovals: SpendExtractor = (p) =>
  listOf(p, "nftApprovals").map(
    (a): SpendItem => ({
      asset: idOf(a.tokenId),
      amount: BigInt(Array.isArray(a.serialNumbers) ? a.serialNumbers.length : 0),
      to: idOf(a.spenderAccountId),
      kind: "nft-allowance",
    }),
  );

/**
 * Extractors for every core Agent Kit tool that moves value or grants someone the right to.
 * Allowance deletions are left out on purpose: revoking an allowance never spends anything.
 */
export const builtinExtractors: Readonly<Record<string, SpendExtractor>> = {
  [account.TRANSFER_HBAR_TOOL]: hbarTransfers,
  [account.TRANSFER_HBAR_WITH_ALLOWANCE_TOOL]: hbarTransfers,
  [account.APPROVE_HBAR_ALLOWANCE_TOOL]: hbarApprovals,
  [account.APPROVE_TOKEN_ALLOWANCE_TOOL]: tokenApprovals,
  [token.TRANSFER_FUNGIBLE_TOKEN_TOOL]: tokenTransfers,
  [token.TRANSFER_FUNGIBLE_TOKEN_WITH_ALLOWANCE_TOOL]: tokenTransfers,
  [token.AIRDROP_FUNGIBLE_TOKEN_TOOL]: tokenTransfers,
  [token.TRANSFER_NON_FUNGIBLE_TOKEN_TOOL]: nftTransfers,
  [token.TRANSFER_NON_FUNGIBLE_TOKEN_WITH_ALLOWANCE_TOOL]: nftTransfers,
  [token.APPROVE_NFT_ALLOWANCE_TOOL]: nftApprovals,
};

/**
 * Core tools that can move value but that these policies cannot measure. `spendPolicies()`
 * rejects them by default; pass `rejectUncovered: false` only if you guard them some other way.
 *
 * - `delete_account_tool` sweeps the whole balance to a beneficiary.
 * - `sign_schedule_transaction_tool` co-signs someone else's Scheduled Transaction, which can
 *   debit the agent's account without passing through any transfer tool.
 * - The ERC-20 / ERC-721 tools send encoded contract calls whose amount is only known on-chain.
 */
export const UNCOVERED_VALUE_TOOLS: readonly string[] = [
  account.DELETE_ACCOUNT_TOOL,
  account.SIGN_SCHEDULE_TRANSACTION_TOOL,
  evm.TRANSFER_ERC20_TOOL,
  evm.TRANSFER_ERC721_TOOL,
];

/** Builds the spend intent for one tool call, or throws if no extractor knows the tool. */
export function extractIntent(
  method: string,
  normalisedParams: unknown,
  rawParams: unknown,
  extractors: Readonly<Record<string, SpendExtractor>>,
  policyName: string,
): SpendIntent {
  const extractor = extractors[method];
  if (!extractor) {
    throw new Error(
      `${policyName}: no spend extractor for tool '${method}'. Pass one in \`extractors\`.`,
    );
  }
  return {
    method,
    items: extractor(normalisedParams, rawParams),
    scheduled:
      (normalisedParams as { schedulingParams?: Bag } | null)?.schedulingParams?.isScheduled ===
      true,
  };
}
