import { PrivateKey } from "@hiero-ledger/sdk";

/**
 * Parses a private key from an env var: `0x`-prefixed hex is ECDSA (the Hedera portal default),
 * DER is self-describing, and bare 64-char hex follows `keyType` (default ECDSA).
 */
export function parsePrivateKey(text, keyType = "ecdsa") {
  const value = text.trim();
  if (/^0x[0-9a-f]{64}$/i.test(value)) return PrivateKey.fromStringECDSA(value);
  if (/^30[0-9a-f]+$/i.test(value) && value.length > 64) return PrivateKey.fromStringDer(value);
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return keyType.toLowerCase() === "ed25519"
      ? PrivateKey.fromStringED25519(value)
      : PrivateKey.fromStringECDSA(value);
  }
  throw new Error("Unrecognised private key format (expected 0x hex, raw hex or DER)");
}
