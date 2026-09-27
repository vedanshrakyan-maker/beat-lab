import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { acct, balance, balances } from "@/ledger/ledger";

/**
 * Ledger integrity check (`npm run ledger:verify`, also a daily worker job and a CI step).
 * Asserts double-entry invariants and that derived balances match the business tables.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
}

const RESERVED_STATUSES = ["UNDER_REVIEW", "APPROVED", "TRACKING", "LOCKED", "HELD", "FLAGGED"] as const;

export async function verifyLedger(): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const checks: CheckResult[] = [];
  const add = (name: string, details: string[]) => checks.push({ name, ok: details.length === 0, details });

  // 1. Every transaction balances to zero.
  const unbalanced = await db.$queryRaw<{ id: string; key: string; total: bigint }[]>`
    SELECT t.id, t."idempotencyKey" AS key, SUM(e."amountPaise")::bigint AS total
    FROM "LedgerTransaction" t JOIN "LedgerEntry" e ON e."transactionId" = t.id
    GROUP BY t.id HAVING SUM(e."amountPaise") <> 0`;
  add(
    "Every transaction sums to zero",
    unbalanced.map((u) => `${u.key}: ${u.total}`),
  );

  // 2. Every transaction has at least two entries.
  const thin = await db.$queryRaw<{ key: string; n: bigint }[]>`
    SELECT t."idempotencyKey" AS key, COUNT(e.id)::bigint AS n
    FROM "LedgerTransaction" t LEFT JOIN "LedgerEntry" e ON e."transactionId" = t.id
    GROUP BY t.id HAVING COUNT(e.id) < 2`;
  add(
    "Every transaction has ≥ 2 entries",
    thin.map((t) => `${t.key}: ${t.n} entries`),
  );

  // 3. Accounts that must never go negative (budget can never be overspent).
  const neverNegative = [
    "campaign_budget",
    "campaign_reserved",
    "payout_clearing",
    "tds_payable",
    "gst_payable",
    "platform_fee_revenue",
    "refund_payable",
    "funder_cash_in",
  ];
  const accounts = await db.ledgerAccount.findMany({
    where: { kind: { in: neverNegative } },
    select: { code: true },
  });
  const bal = await balances(
    db,
    accounts.map((a) => a.code),
  );
  add(
    "No overspent budget or negative system account",
    [...bal].filter(([, v]) => v < 0n).map(([code, v]) => `${code} = ${formatINR(v)}`),
  );

  // 4. Funding, fee and GST match paid FundingPayments.
  const funded = await db.fundingPayment.aggregate({
    where: { status: "PAID" },
    _sum: { budgetPaise: true, feePaise: true, gstPaise: true, amountPaise: true },
  });
  const fundingProblems: string[] = [];
  const fee = await balance(db, acct.platformFeeRevenue());
  const gst = await balance(db, acct.gstPayable());
  if (fee !== (funded._sum.feePaise ?? 0n))
    fundingProblems.push(`fee revenue ${fee} ≠ paid fees ${funded._sum.feePaise ?? 0n}`);
  if (gst !== (funded._sum.gstPaise ?? 0n))
    fundingProblems.push(`GST payable ${gst} ≠ paid GST ${funded._sum.gstPaise ?? 0n}`);
  const perCampaignFunding = await db.$queryRaw<{ campaignId: string; ledger: bigint }[]>`
    SELECT t."campaignId", COALESCE(SUM(-e."amountPaise"), 0)::bigint AS ledger
    FROM "LedgerTransaction" t JOIN "LedgerEntry" e ON e."transactionId" = t.id JOIN "LedgerAccount" a ON a.id = e."accountId"
    WHERE t.kind = 'FUNDING' AND a.kind = 'campaign_budget' GROUP BY t."campaignId"`;
  const paidByCampaign = await db.fundingPayment.groupBy({
    by: ["campaignId"],
    where: { status: "PAID" },
    _sum: { budgetPaise: true },
  });
  const ledgerFunding = new Map(perCampaignFunding.map((r) => [r.campaignId, r.ledger]));
  for (const p of paidByCampaign) {
    const l = ledgerFunding.get(p.campaignId) ?? 0n;
    if (l !== (p._sum.budgetPaise ?? 0n))
      fundingProblems.push(
        `campaign ${p.campaignId}: ledger funding ${l} ≠ paid budget ${p._sum.budgetPaise}`,
      );
  }
  add("Funding, fee and GST match paid funding payments", fundingProblems);

  // 5. Reserved balance per campaign = Σ earnings of submissions still in reserved states.
  const reservedProblems: string[] = [];
  const campaigns = await db.campaign.findMany({ select: { id: true, title: true } });
  const reservedBal = await balances(
    db,
    campaigns.map((c) => acct.campaignReserved(c.id)),
  );
  const earned = await db.submission.groupBy({
    by: ["campaignId"],
    where: { status: { in: [...RESERVED_STATUSES] } },
    _sum: { earnedPaise: true },
  });
  const earnedBy = new Map(earned.map((e) => [e.campaignId, e._sum.earnedPaise ?? 0n]));
  for (const c of campaigns) {
    const r = reservedBal.get(acct.campaignReserved(c.id)) ?? 0n;
    const e = earnedBy.get(c.id) ?? 0n;
    if (r !== e)
      reservedProblems.push(`“${c.title}”: reserved ${formatINR(r)} ≠ submissions' earnings ${formatINR(e)}`);
  }
  add("Reserved balances match submission earnings", reservedProblems);

  // 6. Each submission's cached earnings = accruals − releases − clawbacks.
  const cache = await db.$queryRaw<{ id: string; cached: bigint; ledger: bigint }[]>`
    SELECT s.id, s."earnedPaise" AS cached,
      COALESCE(SUM(CASE
        WHEN t.kind = 'ACCRUAL' AND a.kind = 'campaign_reserved' THEN -e."amountPaise"
        WHEN t.kind = 'RELEASE' AND a.kind = 'campaign_reserved' THEN -e."amountPaise"
        WHEN t.kind = 'CLAWBACK' AND a.kind = 'clipper_payable' THEN -e."amountPaise"
        ELSE 0 END), 0)::bigint AS ledger
    FROM "Submission" s
    LEFT JOIN "LedgerTransaction" t ON t."submissionId" = s.id
    LEFT JOIN "LedgerEntry" e ON e."transactionId" = t.id
    LEFT JOIN "LedgerAccount" a ON a.id = e."accountId"
    GROUP BY s.id HAVING s."earnedPaise" <> COALESCE(SUM(CASE
        WHEN t.kind = 'ACCRUAL' AND a.kind = 'campaign_reserved' THEN -e."amountPaise"
        WHEN t.kind = 'RELEASE' AND a.kind = 'campaign_reserved' THEN -e."amountPaise"
        WHEN t.kind = 'CLAWBACK' AND a.kind = 'clipper_payable' THEN -e."amountPaise"
        ELSE 0 END), 0)`;
  add(
    "Submission earnings cache matches the ledger",
    cache.map((c) => `${c.id}: cached ${c.cached} ≠ ledger ${c.ledger}`),
  );

  // 7. Payout clearing and TDS match the payouts table.
  const payoutProblems: string[] = [];
  const inFlight = await db.payout.aggregate({
    where: { status: { in: ["PENDING", "APPROVED", "PROCESSING"] } },
    _sum: { netPaise: true },
  });
  const clearing = await balance(db, acct.payoutClearing());
  if (clearing !== (inFlight._sum.netPaise ?? 0n))
    payoutProblems.push(`payout_clearing ${clearing} ≠ in-flight net ${inFlight._sum.netPaise ?? 0n}`);
  const tdsHeld = await db.payout.aggregate({
    where: { status: { in: ["PENDING", "APPROVED", "PROCESSING", "PAID"] } },
    _sum: { tdsPaise: true },
  });
  const tds = await balance(db, acct.tdsPayable());
  if (tds !== (tdsHeld._sum.tdsPaise ?? 0n))
    payoutProblems.push(`tds_payable ${tds} ≠ withheld TDS ${tdsHeld._sum.tdsPaise ?? 0n}`);
  add("Payout clearing and TDS match payouts", payoutProblems);

  // 8. Cash = funding received − payouts sent − refunds.
  const paidOut = await db.payout.aggregate({ where: { status: "PAID" }, _sum: { netPaise: true } });
  const refunds = await db.$queryRaw<{ total: bigint | null }[]>`
    SELECT COALESCE(SUM(-e."amountPaise"), 0)::bigint AS total FROM "LedgerTransaction" t
    JOIN "LedgerEntry" e ON e."transactionId" = t.id JOIN "LedgerAccount" a ON a.id = e."accountId"
    WHERE t.kind = 'REFUND_PAID' AND a.kind = 'funder_cash_in'`;
  const cash = await balance(db, acct.funderCashIn());
  const expectedCash =
    (funded._sum.amountPaise ?? 0n) - (paidOut._sum.netPaise ?? 0n) - (refunds[0]?.total ?? 0n);
  add(
    "Cash matches funding − payouts − refunds",
    cash === expectedCash ? [] : [`cash ${cash} ≠ expected ${expectedCash}`],
  );

  return { ok: checks.every((c) => c.ok), checks };
}

export async function recordLedgerVerification(): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const result = await verifyLedger();
  await db.healthCheck.create({
    data: {
      kind: "LEDGER_VERIFY",
      ok: result.ok,
      details: result.checks as unknown as Prisma.InputJsonValue,
    },
  });
  return result;
}
