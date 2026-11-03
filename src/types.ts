/**
 * What a single tool call would move, reduced to a list of outflows.
 *
 * - `transfer`: fungible value (HBAR or an HTS token) leaves to `to`.
 * - `allowance`: `to` is granted the right to pull fungible value later.
 * - `nft`: an NFT serial leaves to `to` (`amount` is the serial count).
 * - `nft-allowance`: `to` is granted the right to pull NFT serials later.
 */
export type SpendKind = "transfer" | "allowance" | "nft" | "nft-allowance";

export interface SpendItem {
  /** `"HBAR"` or an HTS token ID such as `0.0.456858`. */
  asset: string;
  /** Integer base units (tinybars for HBAR). For NFT kinds, the number of serials. */
  amount: bigint;
  /** Receiving account ID (`0.0.x`) or EVM address (`0x…`, lower case). */
  to: string;
  kind: SpendKind;
}

export interface SpendIntent {
  /** The Agent Kit tool method, e.g. `transfer_hbar_tool`. */
  method: string;
  items: SpendItem[];
  /** The agent asked for its own Scheduled Transaction. It is still a spend. */
  scheduled: boolean;
}

/**
 * Turns a tool's normalised parameters into the outflows it would cause. Supply one for any tool
 * the built-in extractors do not know, such as a third-party swap or payment plugin.
 */
// biome-ignore lint/suspicious/noExplicitAny: each tool normalises to its own shape, so extractors are written against the tool they serve.
export type SpendExtractor<TNormalised = any, TRaw = any> = (
  normalisedParams: TNormalised,
  rawParams: TRaw,
) => SpendItem[];

/**
 * A spending limit in display units. HBAR takes a bare number (`10` means 10 HBAR); an HTS token
 * also needs its decimals, so the policy never has to guess them (`{ amount: 25, decimals: 6 }`).
 */
export type CapValue = number | string | { amount: number | string; decimals: number };

/** Limits keyed by asset: `"HBAR"` or an HTS token ID. */
export type CapsConfig = Record<string, CapValue>;

/** A limit resolved to base units, with the decimals needed to print it. */
export interface ResolvedCap {
  limit: bigint;
  decimals: number;
}
