// Owner side of an escalated payment: shows what a pending approval schedule would pay, and
// signs it with --yes. Run it as the owner, never as the agent.
//
//   HEDERA_NETWORK=testnet OWNER_ACCOUNT_ID=0.0.x OWNER_PRIVATE_KEY=0x... \
//     npm run approve -- 0.0.12345          # inspect
//     npm run approve -- 0.0.12345 --yes    # approve (the payment executes)
import {
  Client,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { parsePrivateKey } from "./keys.mjs";

const {
  HEDERA_NETWORK = "testnet",
  OWNER_ACCOUNT_ID,
  OWNER_PRIVATE_KEY,
  OWNER_KEY_TYPE,
} = process.env;
const [scheduleArg, ...flags] = process.argv.slice(2);

if (!OWNER_ACCOUNT_ID || !OWNER_PRIVATE_KEY || !scheduleArg) {
  console.error(
    "Usage: OWNER_ACCOUNT_ID=0.0.x OWNER_PRIVATE_KEY=... npm run approve -- <scheduleId> [--yes]",
  );
  process.exit(1);
}

const ownerKey = parsePrivateKey(OWNER_PRIVATE_KEY, OWNER_KEY_TYPE);
const client = (
  HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet()
).setOperator(OWNER_ACCOUNT_ID, ownerKey);

try {
  const scheduleId = ScheduleId.fromString(scheduleArg);
  const info = await new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client);

  console.log(`schedule   ${scheduleId} (${HEDERA_NETWORK})`);
  console.log(`memo       ${info.scheduleMemo}`);
  console.log(`expires    ${info.expirationTime?.toDate().toISOString() ?? "n/a"}`);
  if (info.executed) console.log(`executed   ${info.executed.toDate().toISOString()}`);
  if (info.deleted) console.log(`deleted    ${info.deleted.toDate().toISOString()}`);

  const scheduled = info.scheduledTransaction;
  if (scheduled instanceof TransferTransaction) {
    for (const [account, amount] of scheduled.hbarTransfers) {
      console.log(`  ${amount.toString().padStart(18)}  ${account}`);
    }
    for (const [token, transfers] of scheduled.tokenTransfers) {
      for (const [account, amount] of transfers) {
        console.log(
          `  ${amount.toString().padStart(18)}  ${account}  (token ${token}, base units)`,
        );
      }
    }
  } else {
    console.log(
      `  not a transfer: ${scheduled?.constructor?.name ?? "unknown"}. Not signing this.`,
    );
    process.exit(1);
  }

  if (info.executed || info.deleted) process.exit(0);
  if (!flags.includes("--yes")) {
    console.log("\nRe-run with --yes to approve. The payment executes as soon as you sign.");
    process.exit(0);
  }

  const receipt = await (
    await new ScheduleSignTransaction().setScheduleId(scheduleId).execute(client)
  ).getReceipt(client);
  console.log(`\nsigned: ${receipt.status}`);
} finally {
  client.close();
}
