import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { acct, balance, balances, credit, debit, LedgerError, post } from "@/ledger/ledger";
import { verifyLedger } from "@/ledger/verify";
import { resetDb } from "./factories";

describe("ledger", () => {
  beforeEach(resetDb);

  it("posts balanced transactions and derives natural balances", async () => {
    await db.$transaction((tx) =>
      post(tx, {
        idempotencyKey: "t1",
        kind: "FUNDING",
        description: "test",
        entries: [
          debit(acct.funderCashIn(), 1180n),
          credit(acct.campaignBudget("c1"), 1000n),
          credit(acct.platformFeeRevenue(), 100n),
          credit(acct.gstPayable(), 80n),
        ],
      }),
    );
    expect(await balance(db, acct.funderCashIn())).toBe(1180n);
    expect(await balance(db, acct.campaignBudget("c1"))).toBe(1000n);
    const map = await balances(db, [
      acct.platformFeeRevenue(),
      acct.gstPayable(),
      acct.campaignReserved("none"),
    ]);
    expect(map.get(acct.platformFeeRevenue())).toBe(100n);
    expect(map.get(acct.gstPayable())).toBe(80n);
    expect(map.get(acct.campaignReserved("none"))).toBe(0n);
  });

  it("rejects unbalanced transactions", async () => {
    await expect(
      post(db, {
        idempotencyKey: "bad",
        kind: "ACCRUAL",
        description: "x",
        entries: [debit(acct.campaignBudget("c"), 10n), credit(acct.campaignReserved("c"), 9n)],
      }),
    ).rejects.toThrow(LedgerError);
  });

  it("is idempotent on the key", async () => {
    const input = {
      idempotencyKey: "same",
      kind: "ACCRUAL" as const,
      description: "x",
      entries: [debit(acct.funderCashIn(), 5n), credit(acct.campaignBudget("c"), 5n)],
    };
    expect((await post(db, input)).created).toBe(true);
    expect((await post(db, input)).created).toBe(false);
    expect(await db.ledgerTransaction.count()).toBe(1);
    expect(await balance(db, acct.campaignBudget("c"))).toBe(5n);
  });

  it("ledger:verify passes on an empty ledger", async () => {
    const r = await verifyLedger();
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
