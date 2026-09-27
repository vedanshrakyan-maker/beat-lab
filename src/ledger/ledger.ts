import { Prisma, type LedgerAccountType } from "@prisma/client";
import type { DbOrTx } from "@/lib/db";
import type { Paise } from "@/lib/money";

/**
 * Double-entry ledger. Every rupee movement is a LedgerTransaction whose entries sum to
 * zero (positive = debit, negative = credit) and which carries a unique idempotency key.
 * Balances are ALWAYS derived by summing entries. See docs/LEDGER.md.
 */

export const accountKinds = {
  funder_cash_in: { type: "ASSET", description: "Cash received from funders via the payment provider" },
  campaign_budget: { type: "LIABILITY", description: "Available clipper-facing budget of a campaign" },
  campaign_reserved: { type: "LIABILITY", description: "Earnings accrued but not yet payable" },
  platform_fee_revenue: { type: "REVENUE", description: "Platform fee earned on funded budgets" },
  gst_payable: { type: "LIABILITY", description: "GST collected on the platform fee" },
  clipper_payable: { type: "LIABILITY", description: "Cleared earnings owed to a clipper" },
  tds_payable: { type: "LIABILITY", description: "TDS withheld from payouts, owed to the government" },
  payout_clearing: { type: "LIABILITY", description: "Committed to payouts, awaiting provider confirmation" },
  refund_payable: { type: "LIABILITY", description: "Unused budget to be returned to an organization" },
} as const satisfies Record<string, { type: LedgerAccountType; description: string }>;

export type AccountKind = keyof typeof accountKinds;

export const acct = {
  funderCashIn: () => "funder_cash_in",
  campaignBudget: (campaignId: string) => `campaign_budget:${campaignId}`,
  campaignReserved: (campaignId: string) => `campaign_reserved:${campaignId}`,
  platformFeeRevenue: () => "platform_fee_revenue",
  gstPayable: () => "gst_payable",
  clipperPayable: (userId: string) => `clipper_payable:${userId}`,
  tdsPayable: () => "tds_payable",
  payoutClearing: () => "payout_clearing",
  refundPayable: (organizationId: string) => `refund_payable:${organizationId}`,
};

export function parseAccountCode(code: string): { kind: AccountKind; ownerId: string | null } {
  const [kind, ownerId] = code.split(":") as [string, string | undefined];
  if (!(kind in accountKinds)) throw new Error(`Unknown ledger account kind: ${kind}`);
  return { kind: kind as AccountKind, ownerId: ownerId ?? null };
}

export type TransactionKind =
  | "FUNDING"
  | "ACCRUAL"
  | "RELEASE" // reserved -> budget (void, reduction after view drop, cap adjustments)
  | "CLEARING" // reserved -> clipper_payable
  | "CLAWBACK" // clipper_payable -> budget (fraud found after clearing / payment)
  | "PAYOUT_REQUEST"
  | "PAYOUT_PAID"
  | "PAYOUT_FAILED"
  | "CAMPAIGN_END"
  | "REFUND_PAID";

export interface EntryInput {
  account: string;
  /** Positive = debit, negative = credit. */
  amount: Paise;
}

export const debit = (account: string, amount: Paise): EntryInput => ({ account, amount });
export const credit = (account: string, amount: Paise): EntryInput => ({ account, amount: -amount });

export interface PostInput {
  idempotencyKey: string;
  kind: TransactionKind;
  description: string;
  entries: EntryInput[];
  campaignId?: string;
  submissionId?: string;
  payoutId?: string;
  userId?: string;
  metadata?: Prisma.InputJsonValue;
}

export class LedgerError extends Error {}

/**
 * Post a balanced transaction. Idempotent: if a transaction with the same key already
 * exists, nothing is written and `{ created: false }` is returned.
 * Must be called inside a DB transaction together with the business-state change it records.
 */
export async function post(
  tx: DbOrTx,
  input: PostInput,
): Promise<{ created: boolean; transactionId: string }> {
  const entries = input.entries.filter((e) => e.amount !== 0n);
  const sum = entries.reduce((acc, e) => acc + e.amount, 0n);
  if (sum !== 0n) throw new LedgerError(`Unbalanced transaction ${input.idempotencyKey}: sums to ${sum}`);

  const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { created: false, transactionId: existing.id };
  if (entries.length < 2)
    throw new LedgerError(`Transaction ${input.idempotencyKey} needs at least 2 non-zero entries`);

  const accountIds = await ensureAccounts(tx, [...new Set(entries.map((e) => e.account))]);
  const created = await tx.ledgerTransaction.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      description: input.description,
      campaignId: input.campaignId,
      submissionId: input.submissionId,
      payoutId: input.payoutId,
      userId: input.userId,
      metadata: input.metadata,
      entries: {
        create: entries.map((e) => ({ accountId: accountIds.get(e.account)!, amountPaise: e.amount })),
      },
    },
  });
  return { created: true, transactionId: created.id };
}

async function ensureAccounts(tx: DbOrTx, codes: string[]): Promise<Map<string, string>> {
  await tx.ledgerAccount.createMany({
    data: codes.map((code) => {
      const { kind, ownerId } = parseAccountCode(code);
      return { code, kind, ownerId, type: accountKinds[kind].type };
    }),
    skipDuplicates: true,
  });
  const rows = await tx.ledgerAccount.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true },
  });
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** Raw signed sum of entries (debits positive). */
async function rawSum(tx: DbOrTx, code: string): Promise<Paise> {
  const result = await tx.ledgerEntry.aggregate({
    where: { account: { code } },
    _sum: { amountPaise: true },
  });
  return result._sum.amountPaise ?? 0n;
}

/**
 * Natural balance of an account: assets are debit-normal, liabilities and revenue are
 * credit-normal. A positive result is the "normal" state (e.g. budget available).
 */
export async function balance(tx: DbOrTx, code: string): Promise<Paise> {
  const { kind } = parseAccountCode(code);
  const sum = await rawSum(tx, code);
  return accountKinds[kind].type === "ASSET" ? sum : -sum;
}

/** Natural balances for many accounts in one query. Missing accounts are 0. */
export async function balances(tx: DbOrTx, codes: string[]): Promise<Map<string, Paise>> {
  const out = new Map<string, Paise>(codes.map((c) => [c, 0n]));
  if (codes.length === 0) return out;
  const rows = await tx.$queryRaw<{ code: string; type: LedgerAccountType; total: bigint | null }[]>`
    SELECT a.code, a.type, COALESCE(SUM(e."amountPaise"), 0)::bigint AS total
    FROM "LedgerAccount" a
    LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
    WHERE a.code IN (${Prisma.join(codes)})
    GROUP BY a.code, a.type`;
  for (const r of rows) {
    const total = r.total ?? 0n;
    out.set(r.code, r.type === "ASSET" ? total : -total);
  }
  return out;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
