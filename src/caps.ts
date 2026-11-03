import type { CapsConfig, ResolvedCap, SpendItem } from "./types";
import { HBAR, HBAR_DECIMALS, formatUnits, toBaseUnits } from "./units";

const TOKEN_ID = /^\d+\.\d+\.\d+$/;

/** Validates a caps config and converts every limit to base units. */
export function resolveCaps(caps: CapsConfig, label: string): Map<string, ResolvedCap> {
  const resolved = new Map<string, ResolvedCap>();
  for (const [asset, value] of Object.entries(caps)) {
    if (asset !== HBAR && !TOKEN_ID.test(asset)) {
      throw new Error(`${label}: cap key "${asset}" must be "HBAR" or a token ID like 0.0.456858`);
    }
    let amount: number | string;
    let decimals: number;
    if (typeof value === "object") {
      amount = value.amount;
      decimals = value.decimals;
    } else if (asset === HBAR) {
      amount = value;
      decimals = HBAR_DECIMALS;
    } else {
      throw new Error(
        `${label}: token ${asset} needs its decimals, e.g. { amount: ${value}, decimals: 6 }`,
      );
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`${label}: decimals for ${asset} must be an integer from 0 to 18`);
    }
    resolved.set(asset, {
      limit: toBaseUnits(amount, decimals, `${label} cap for ${asset}`),
      decimals,
    });
  }
  return resolved;
}

/** The kinds that carry fungible value and therefore count against amount caps. */
export function isFungible(item: SpendItem): boolean {
  return item.kind === "transfer" || item.kind === "allowance";
}

/** Sums fungible outflows per asset, in base units. */
export function totalsByAsset(items: SpendItem[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const item of items) {
    if (!isFungible(item)) continue;
    totals.set(item.asset, (totals.get(item.asset) ?? 0n) + item.amount);
  }
  return totals;
}

/** Human-readable amount: `12.5 HBAR`, `25 of 0.0.456858`, or base units when decimals are unknown. */
export function describeAmount(asset: string, amount: bigint, decimals?: number): string {
  if (asset === HBAR) return `${formatUnits(amount, HBAR_DECIMALS)} HBAR`;
  if (decimals === undefined) return `${amount} base units of ${asset}`;
  return `${formatUnits(amount, decimals)} of ${asset}`;
}
