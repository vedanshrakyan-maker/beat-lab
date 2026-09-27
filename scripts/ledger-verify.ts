/** npm run ledger:verify — exits non-zero if any ledger invariant fails. */
import { db } from "@/lib/db";
import { recordLedgerVerification } from "@/ledger/verify";

async function main() {
  const { ok, checks } = await recordLedgerVerification();
  console.log("\nLedger verification\n");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}`);
    for (const d of c.details.slice(0, 20)) console.log(`    ${d}`);
  }
  const [txCount, entryCount] = await Promise.all([db.ledgerTransaction.count(), db.ledgerEntry.count()]);
  console.log(`\n${txCount} transactions, ${entryCount} entries — ${ok ? "OK" : "FAILED"}\n`);
  await db.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
