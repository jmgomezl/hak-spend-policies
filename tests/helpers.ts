import { type AbstractHook, AgentMode, type Context, type Tool } from "@hashgraph/hedera-agent-kit";
import { coreAccountPlugin, coreTokenPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import type { SpendIntent } from "../src/types";

export const AGENT = "0.0.1001";
export const OWNER = "0.0.2002";
export const SHOP = "0.0.800";
export const CAFE = "0.0.801";
export const STRANGER = "0.0.666";
export const USDC = "0.0.456858";
export const NFT = "0.0.777";

/** A testnet client with no operator. RETURN_BYTES mode never needs one or touches the network. */
export const client = Client.forTestnet();

export const AGENT_PUBLIC_KEY = PrivateKey.generateED25519().publicKey.toStringDer();

/** Answers the mirror-node lookups the normalisers make, without a network. */
export const fakeMirror = {
  getAccount: async (accountId: string) => ({ accountId, accountPublicKey: AGENT_PUBLIC_KEY }),
  getTokenInfo: async (_tokenId: string) => ({ decimals: "6" }),
  getScheduledTransactionDetails: async (_scheduleId: string) => {
    throw new Error("set mirror.getScheduledTransactionDetails in the test");
  },
};

export function contextWith(hooks: AbstractHook[], extra: Partial<Context> = {}): Context {
  return {
    mode: AgentMode.RETURN_BYTES,
    accountId: AGENT,
    hooks,
    mirrornodeService: fakeMirror as unknown as Context["mirrornodeService"],
    ...extra,
  };
}

export interface ToolOutcome {
  ok: boolean;
  message: string;
  result: { raw?: { status?: string; error?: string }; humanMessage?: string };
}

/**
 * Runs a real core Agent Kit tool end to end (normalisation, hooks, transaction build) in
 * RETURN_BYTES mode, so the policies are exercised exactly as an agent would hit them.
 */
export async function runTool(
  method: string,
  params: Record<string, unknown>,
  hooks: AbstractHook[],
  extra: Partial<Context> = {},
): Promise<ToolOutcome> {
  const context = contextWith(hooks, extra);
  const tools: Tool[] = [...coreAccountPlugin.tools(context), ...coreTokenPlugin.tools(context)];
  const tool = tools.find((candidate) => candidate.method === method);
  if (!tool) throw new Error(`no core tool ${method}`);
  const result = await tool.execute(client, context, params);
  const ok = result?.raw?.status !== "ERROR";
  return { ok, message: result?.humanMessage ?? result?.raw?.error ?? "", result };
}

export const hbarIntent = (to: string, tinybars: bigint): SpendIntent => ({
  method: "transfer_hbar_tool",
  items: [{ asset: "HBAR", amount: tinybars, to, kind: "transfer" }],
  scheduled: false,
});

/** A controllable clock for the policies' `now` option. */
export function clock(start: string) {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
  };
}

export const HOUR = 3_600_000;
