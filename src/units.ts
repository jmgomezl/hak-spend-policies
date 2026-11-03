/** Asset key used for HBAR. Every other asset is keyed by its HTS token ID (`0.0.x`). */
export const HBAR = "HBAR";

/** Tinybars per HBAR. */
export const HBAR_DECIMALS = 8;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Converts a display amount (`12.5`, `"0.000001"`) to integer base units.
 *
 * Works on the decimal string, never on floating point, so `0.1 + 0.2` style drift cannot leak
 * into a spending limit. Rejects negative values and more fractional digits than `decimals`.
 */
export function toBaseUnits(value: number | string, decimals: number, label = "amount"): bigint {
  const text = typeof value === "number" ? numberToPlain(value, label) : value.trim();
  if (!PLAIN_DECIMAL.test(text)) {
    throw new Error(`${label} must be a non-negative decimal number, got "${value}"`);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals && /[^0]/.test(fraction.slice(decimals))) {
    throw new Error(`${label} "${value}" has more than ${decimals} decimal places`);
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

/** Formats integer base units back to a display string, trimming trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Reads an integer amount out of whatever the Agent Kit normaliser produced.
 *
 * After normalisation an amount can be an SDK `Hbar`, a `Long`, a `BigNumber`, a `bigint`, a
 * number or a numeric string. `Hbar` is read as tinybars; everything else must already be an
 * integer in base units.
 */
export function toBigInt(amount: unknown): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) throw new Error(`Expected an integer amount, got ${amount}`);
    return BigInt(amount);
  }
  if (typeof amount === "string") return BigInt(amount);
  if (amount && typeof amount === "object") {
    const candidate = amount as { toTinybars?: () => unknown; toFixed?: () => string };
    if (typeof candidate.toTinybars === "function") return toBigInt(candidate.toTinybars());
    // BigNumber.toString() may use exponent notation; toFixed() never does.
    if (typeof candidate.toFixed === "function" && !("low" in candidate)) {
      return BigInt(candidate.toFixed());
    }
    return BigInt(String(amount));
  }
  throw new Error(`Cannot read amount from ${String(amount)}`);
}

function numberToPlain(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number, got ${value}`);
  }
  const text = value.toString();
  if (!/e/i.test(text)) return text;
  if (value >= 1e21) throw new Error(`${label} ${value} is too large`);
  return value.toFixed(20).replace(/\.?0+$/, "");
}
