# hak-spend-policies

Spending policies for the [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js):
**per-transaction caps, daily caps, payee allowlists and time windows**, plus a native
**Scheduled Transaction approval step** for payments that go over the limits.

```bash
npm install hak-spend-policies
```

Hedera's [Agent Accounts](https://hedera.com/agent-accounts/) announce exactly this rule set
(daily limits, per-transaction caps, approved recipients, time restrictions) for agents that
hold money. This package gives any Agent Kit agent the same rules today, enforced inside the
tool pipeline before a transaction is built. The approval step is enforced on-chain, because it
needs a key the agent does not hold.

## Quick start

```ts
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { coreAccountPlugin, coreTokenPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import { HederaLangchainToolkit } from "@hashgraph/hedera-agent-kit-langchain";
import { FileSpendStore, spendPolicies } from "hak-spend-policies";

const USDC = "0.0.456858";

const spend = spendPolicies({
  perTransaction: { HBAR: 5, [USDC]: { amount: 20, decimals: 6 } },
  daily: { HBAR: 20, [USDC]: { amount: 100, decimals: 6 } },
  payees: ["0.0.800", "0.0.4812"],
  hours: {
    timeZone: "America/Bogota",
    windows: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00" }],
  },
  approval: { ownerAccountId: "0.0.1234" }, // the owner wallet, not the agent
  ledger: new FileSpendStore("./spend-ledger.json"),
});

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: {
    plugins: [coreAccountPlugin, coreTokenPlugin, spend.plugin],
    context: { mode: AgentMode.AUTONOMOUS, hooks: spend.hooks },
  },
});
```

When the model tries something outside the rules, the tool call fails with a message written
for the model:

```
[Per-Transaction Cap] 8 HBAR is over the per-transaction cap of 5 HBAR. The payment was NOT
sent. Owner approval was requested instead: scheduled transaction 0.0.5005 will pay it from
0.0.1234 as soon as that account signs it (expires 2026-10-23T15:00:00.000Z). Do not retry
the payment; tell the user to approve schedule 0.0.5005.
```

## The policies

| Policy | What it stops | Notes |
| --- | --- | --- |
| `PerTxCapPolicy` | A single call moving more than the cap | A call paying several recipients is measured by its total, so splitting does not help. Allowance grants count as exposure. |
| `DailySpendCapPolicy` | Spending past the cap within a window | Rolling 24 hours by default, or `{ type: "calendar", timeZone }` for a midnight reset. Budget is reserved when a call passes and committed when it succeeds, so parallel calls cannot share the same remaining budget. |
| `PayeeAllowlistPolicy` | Value going to anyone not on the list | Covers transfers, airdrops, NFT transfers and allowance grants (an allowance is a way to let an outsider take funds later). |
| `TimeWindowPolicy` | Any transaction outside set hours | Applies to every transaction tool, not just payments. Queries are never restricted. Windows may run past midnight. |

Caps are written in display units. HBAR takes a bare number; an HTS token takes
`{ amount, decimals }` so the policy never has to guess. **An asset with no cap cannot be moved
at all** unless you pass `allowUnlistedAssets: true`.

`spendPolicies()` also refuses the core tools that move value in ways no policy can measure:
`delete_account_tool` (sweeps the balance), `sign_schedule_transaction_tool` (co-signing a
schedule someone else created can debit the agent without any transfer tool) and the ERC-20 /
ERC-721 transfer tools. Turn that off with `rejectUncovered: false`, or give one of them an
extractor (below) and it is measured instead of refused.

## The approval step

With `approval` set, a payment that breaks a cap is not just refused. The agent creates a
Scheduled Transaction that pays **the same recipients the same amounts from the owner's
account**:

```
agent ──transfer 8 HBAR──▶ PerTxCapPolicy ✗ over cap
   │
   └─ ScheduleCreate( TransferTransaction: owner −8 HBAR, shop +8 HBAR )   agent pays the fee
                │
      owner signs (wallet, or `npm run approve -- 0.0.5005 --yes`)
                │
      network executes the transfer ──▶ shop is paid
```

- The agent cannot complete it: the transfer debits the owner, so only the owner's key can
  release it. `ScheduledApproval` refuses to run if the owner is the agent's own operator.
- Nothing sits in between. No contract, no backend, no keeper: the network holds the pending
  payment and executes it on the signature, or lets it lapse at expiry (24 hours by default,
  at most 62 days).
- A model that retries the refused payment gets the same pending schedule back, not a pile of
  duplicates.
- `onRequested` fires after each request, to notify the owner on Telegram, email or wherever.
- By default, cap breaches escalate and allowlist or time-window breaches are plainly refused.
  Pick with `approval.escalate: ["perTransaction", "daily", "payees", "hours"]`.
- Only HBAR and fungible token transfers can be escalated. NFT transfers and allowance grants
  are refused outright.

The owner side ships as a script that shows what the schedule pays before signing:

```bash
OWNER_ACCOUNT_ID=0.0.1234 OWNER_PRIVATE_KEY=0x... npm run approve -- 0.0.5005        # inspect
OWNER_ACCOUNT_ID=0.0.1234 OWNER_PRIVATE_KEY=0x... npm run approve -- 0.0.5005 --yes  # approve
```

## Tools for the model

`spend.plugin` adds two read-only tools, so the model can plan around its limits instead of
discovering them from refusals:

| Tool | Returns |
| --- | --- |
| `spend_get_budget` | Per-transaction caps, what is spent and left in the daily window, allowed payees, whether it is inside allowed hours, pending approvals |
| `spend_approval_status` | Whether a schedule was `approved` (executed), is `pending`, `expired` or `rejected`, read from the mirror node at no cost |

## What these policies guarantee, and what they do not

Read this before trusting real money to an agent.

- **The caps, allowlist and hours are agent-side.** They run inside the Agent Kit tool pipeline,
  so they bind every tool call the model makes. They do not bind code that holds the agent's
  key and calls the SDK directly. Give the agent only as much as it may lose: a small float in
  its own account, or (as Agent Accounts do) an **HBAR or token allowance from the owner**, so
  the allowance amount is a hard on-chain ceiling and these policies shape spending within it.
- **The approval step is on-chain.** An escalated payment can only execute with the owner's
  signature, whatever the agent does.
- **The daily ledger is local state.** Use `FileSpendStore` so it survives restarts, and a shared
  `SpendStore` (Redis, SQLite, an HCS topic) if several agent processes spend from one budget.
  A failed transaction's reservation is held until it lapses (2 minutes by default) before its
  budget comes back.
- **In `RETURN_BYTES` mode** a payment counts once its bytes are handed to the signer, even if
  the user then declines to sign. That errs on the side of spending less.
- **Caps cover fungible value.** NFTs are covered by the allowlist and the hours, not the caps.
- **Third-party tools are invisible until you describe them.** See below.

## Covering other tools

Each policy reads a call through an extractor that lists its outflows. Built-in extractors cover
every core Agent Kit tool that moves value. For a third-party tool, add one:

```ts
const ROUTER = "0.0.xxxxxxx"; // the DEX router your swap plugin pays

const spend = spendPolicies({
  // ...
  extractors: {
    // A hypothetical swap tool whose normalised params carry the HBAR going in, in tinybars.
    my_swap_tool: (normalised) => [
      { asset: "HBAR", amount: BigInt(normalised.amountIn), to: ROUTER, kind: "transfer" },
    ],
  },
});
```

`to` is whoever receives the value (here the router), so the allowlist can name it. Amounts are
integer base units: tinybars for HBAR, the token's smallest unit otherwise.

## Using the policies on their own

Every policy is a regular `AbstractPolicy` and can go straight into `context.hooks`:

```ts
import {
  DailySpendCapPolicy,
  PayeeAllowlistPolicy,
  PerTxCapPolicy,
  ScheduledApproval,
  SpendLedger,
  TimeWindowPolicy,
} from "hak-spend-policies";

const approval = new ScheduledApproval({ ownerAccountId: "0.0.1234" });
const hooks = [
  new TimeWindowPolicy({ timeZone: "UTC", windows: [{ start: "06:00", end: "22:00" }] }),
  new PayeeAllowlistPolicy({ payees: ["0.0.800"] }),
  new PerTxCapPolicy({ caps: { HBAR: 5 }, approval }),
  new DailySpendCapPolicy({ caps: { HBAR: 20 }, ledger: new SpendLedger(), approval }),
];
```

Keep `DailySpendCapPolicy` last: it reserves budget, and a reservation made before a later
policy refuses the call stays held until it lapses.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

The unit tests run the real core Agent Kit tools (normalisation, hooks and transaction build)
in `RETURN_BYTES` mode, so they exercise the policies exactly as an agent hits them, without a
network.

`npm run test:integration` runs the whole flow on **testnet** with a funded account as the
agent: a payment inside the limits executes, an unknown payee is refused, an over-cap payment
becomes a real approval schedule, the owner signs it and the shop is paid, and a daily-cap
breach is escalated too. The script creates throwaway owner, shop and stranger accounts and
deletes them at the end, which returns their HBAR.

```bash
npm run build
node --env-file=.env scripts/integration-test.mjs
```

## Roadmap

- **HIP-1195 account allowance hooks.** The Hiero SDK already carries hook calls on transfers.
  Once hooks are live on mainnet, the per-transaction and daily caps can move into a hook on the
  owner's account, making them on-chain like the approval step.
- **Mirror node reconciliation** of the daily ledger, so it can be rebuilt from the chain.
- **An Agent Accounts backend** when Hedera publishes its API, keeping this config format.

## License

MIT
