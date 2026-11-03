// Exercises the policies end to end on Hedera testnet with real Agent Kit tools in AUTONOMOUS
// mode: a payment inside the limits executes, an unknown payee is refused, an over-cap payment
// becomes a real approval schedule that executes once the owner signs, and a daily-cap breach
// is escalated too. The owner and shop accounts are created for the run and deleted at the end,
// which sends their HBAR back to the operator.
//
//   npm run build
//   HEDERA_NETWORK=testnet HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=0x... npm run test:integration
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { coreAccountPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountDeleteTransaction,
  Client,
  Hbar,
  PrivateKey,
  ScheduleSignTransaction,
} from "@hiero-ledger/sdk";
import { spendPolicies } from "../dist/index.js";
import { parsePrivateKey } from "./keys.mjs";

const {
  HEDERA_NETWORK = "testnet",
  HEDERA_ACCOUNT_ID,
  HEDERA_PRIVATE_KEY,
  HEDERA_KEY_TYPE,
} = process.env;

if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) {
  console.error("Set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY (see .env.example).");
  process.exit(1);
}
if (HEDERA_NETWORK !== "testnet") {
  console.error("The integration test only runs on testnet.");
  process.exit(1);
}

const agentKey = parsePrivateKey(HEDERA_PRIVATE_KEY, HEDERA_KEY_TYPE);
const client = Client.forTestnet().setOperator(HEDERA_ACCOUNT_ID, agentKey);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) failures += 1;
}

async function createAccount(key, hbar) {
  const receipt = await (
    await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(new Hbar(hbar))
      .execute(client)
  ).getReceipt(client);
  return receipt.accountId.toString();
}

async function hbarOf(accountId) {
  const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  return balance.hbars.toTinybars().toNumber();
}

async function deleteAccount(accountId, key) {
  const tx = await new AccountDeleteTransaction()
    .setAccountId(accountId)
    .setTransferAccountId(HEDERA_ACCOUNT_ID)
    .freezeWith(client)
    .sign(key);
  await (await tx.execute(client)).getReceipt(client);
}

const ownerKey = PrivateKey.generateECDSA();
const shopKey = PrivateKey.generateECDSA();
const strangerKey = PrivateKey.generateECDSA();
const owner = await createAccount(ownerKey, 4);
const shop = await createAccount(shopKey, 0);
const stranger = await createAccount(strangerKey, 0);
console.log(`agent ${HEDERA_ACCOUNT_ID}  owner ${owner}  shop ${shop}  stranger ${stranger}\n`);

const requested = [];
const spend = spendPolicies({
  perTransaction: { HBAR: 1 },
  daily: { HBAR: 1.2 },
  payees: [shop],
  approval: {
    ownerAccountId: owner,
    expiresInSeconds: 900,
    memoPrefix: "hak-spend-policies test",
    onRequested: (request) => requested.push(request),
  },
});
const context = { mode: AgentMode.AUTONOMOUS, accountId: HEDERA_ACCOUNT_ID, hooks: spend.hooks };
const tools = [...coreAccountPlugin.tools(context), ...spend.plugin.tools(context)];
const tool = (method) => tools.find((candidate) => candidate.method === method);
const pay = (to, amount) =>
  tool("transfer_hbar_tool").execute(client, context, { transfers: [{ accountId: to, amount }] });

try {
  const shopStart = await hbarOf(shop);

  const small = await pay(shop, 0.5);
  check("0.5 HBAR to the shop executes", small.raw?.status === "SUCCESS", small.raw?.transactionId);

  const outsider = await pay(stranger, 0.1);
  check(
    "0.1 HBAR to an unknown payee is refused",
    outsider.raw?.status === "ERROR" &&
      outsider.humanMessage.includes("not on the payee allowlist"),
  );

  const big = await pay(shop, 1.5);
  const approval = requested[0];
  check(
    "1.5 HBAR (over the 1 HBAR cap) becomes an approval schedule",
    big.raw?.status === "ERROR" && approval && big.humanMessage.includes(approval.scheduleId),
    approval?.scheduleId,
  );

  await sleep(6_000);
  const status = tool("spend_approval_status");
  const pending = await status.execute(client, context, { scheduleId: approval.scheduleId });
  check("the approval reads as pending", pending.raw?.state === "pending", pending.raw?.state);

  const retry = await pay(shop, 1.5);
  check(
    "retrying the same payment reuses the pending schedule",
    requested.length === 1 && retry.humanMessage.includes(approval.scheduleId),
  );

  // The owner approves. In real use this is their wallet, or `npm run approve`.
  const sign = await new ScheduleSignTransaction()
    .setScheduleId(approval.scheduleId)
    .freezeWith(client)
    .sign(ownerKey);
  const signed = await (await sign.execute(client)).getReceipt(client);
  check("the owner's signature is accepted", signed.status.toString() === "SUCCESS");

  let approved;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(3_000);
    approved = await status.execute(client, context, { scheduleId: approval.scheduleId });
    if (approved.raw?.state === "approved") break;
  }
  check(
    "the approval reads as approved",
    approved.raw?.state === "approved",
    approved.raw?.executedAt,
  );

  const shopGain = (await hbarOf(shop)) - shopStart;
  check("the shop received 0.5 + 1.5 HBAR", shopGain === 200_000_000, `${shopGain / 1e8} HBAR`);

  const overDaily = await pay(shop, 0.8);
  check(
    "0.8 HBAR after 0.5 spent breaches the 1.2 HBAR daily cap and is escalated",
    overDaily.raw?.status === "ERROR" &&
      overDaily.humanMessage.includes("[Daily Spend Cap]") &&
      requested.length === 2,
    requested[1]?.scheduleId,
  );

  const budget = await tool("spend_get_budget").execute(client, context, {});
  check(
    "spend_get_budget shows 0.7 HBAR left today",
    budget.humanMessage.includes("0.7 HBAR left of 1.2 HBAR"),
  );
  console.log(`\n${budget.humanMessage}\n`);
} finally {
  for (const [id, key] of [
    [owner, ownerKey],
    [shop, shopKey],
    [stranger, strangerKey],
  ]) {
    await deleteAccount(id, key).catch((error) =>
      console.warn(`could not delete ${id}`, error.message),
    );
  }
  client.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
