import { Hbar, Long } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { resolveCaps } from "../src/caps";
import { formatUnits, toBaseUnits, toBigInt } from "../src/units";

describe("toBaseUnits", () => {
  it("converts display amounts on the decimal string, not floats", () => {
    expect(toBaseUnits(12.5, 8)).toBe(1_250_000_000n);
    expect(toBaseUnits("0.1", 6)).toBe(100_000n);
    expect(toBaseUnits(0.3, 6)).toBe(300_000n);
    expect(toBaseUnits(1e-8, 8)).toBe(1n);
    expect(toBaseUnits("20", 0)).toBe(20n);
  });

  it("allows trailing zeros past the precision but not real extra digits", () => {
    expect(toBaseUnits("1.500000000", 6)).toBe(1_500_000n);
    expect(() => toBaseUnits("1.0000001", 6)).toThrow(/more than 6 decimal places/);
  });

  it("rejects negative, empty and malformed amounts", () => {
    expect(() => toBaseUnits(-1, 8)).toThrow();
    expect(() => toBaseUnits("", 8)).toThrow();
    expect(() => toBaseUnits("1e3", 8)).toThrow();
    expect(() => toBaseUnits(Number.NaN, 8)).toThrow();
  });
});

describe("formatUnits", () => {
  it("round-trips and trims trailing zeros", () => {
    expect(formatUnits(1_250_000_000n, 8)).toBe("12.5");
    expect(formatUnits(1n, 8)).toBe("0.00000001");
    expect(formatUnits(5_000_000n, 6)).toBe("5");
    expect(formatUnits(-150n, 2)).toBe("-1.5");
  });
});

describe("toBigInt", () => {
  it("reads every shape the Agent Kit normaliser produces", () => {
    expect(toBigInt(new Hbar(2))).toBe(200_000_000n);
    expect(toBigInt(Hbar.fromTinybars(-5))).toBe(-5n);
    expect(toBigInt(Long.fromString("9007199254740993"))).toBe(9_007_199_254_740_993n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt("7")).toBe(7n);
    expect(toBigInt(3n)).toBe(3n);
  });

  it("refuses fractional base units", () => {
    expect(() => toBigInt(1.5)).toThrow();
  });
});

describe("resolveCaps", () => {
  it("takes HBAR as a bare number and requires decimals for tokens", () => {
    const caps = resolveCaps({ HBAR: 5, "0.0.456858": { amount: 25, decimals: 6 } }, "test");
    expect(caps.get("HBAR")).toEqual({ limit: 500_000_000n, decimals: 8 });
    expect(caps.get("0.0.456858")).toEqual({ limit: 25_000_000n, decimals: 6 });
    expect(() => resolveCaps({ "0.0.456858": 25 }, "test")).toThrow(/needs its decimals/);
  });

  it("rejects keys that are neither HBAR nor a token ID", () => {
    expect(() => resolveCaps({ USDC: 5 }, "test")).toThrow(/must be "HBAR" or a token ID/);
  });
});
