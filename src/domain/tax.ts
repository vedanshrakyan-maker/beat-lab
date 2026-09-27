import type { TaxRule } from "@prisma/client";
import { z } from "zod";
import { audit, type Actor } from "@/lib/audit";
import { db, type DbOrTx } from "@/lib/db";
import { bpsOf, formatINR, type Paise } from "@/lib/money";

/**
 * Configurable TDS engine. Rates, thresholds and section labels live in the TaxRule table —
 * NEVER in code. India's Income-tax Act, 2025 (in force 1 April 2026) renumbered the TDS
 * provisions, and creator payments have been classified under different provisions depending
 * on the contract. The seeded rule is a PLACEHOLDER to be confirmed with a CA.
 */

const IST_OFFSET_MS = 330 * 60_000;

/** Indian financial year (1 April – 31 March, IST) containing `date`. */
export function financialYearOf(date: Date): { start: Date; end: Date; label: string } {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(y, 3, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y + 1, 3, 1) - IST_OFFSET_MS);
  return { start, end, label: `${y}-${String((y + 1) % 100).padStart(2, "0")}` };
}

export interface TdsComputation {
  tdsPaise: Paise;
  rateBps: number;
  thresholdCrossed: boolean;
  panApplied: boolean;
  fyCumulativeBeforePaise: Paise;
  ruleId: string | null;
  explanation: string;
}

/** Pure TDS calculation for one payout. */
export function computeTds(
  rule: Pick<
    TaxRule,
    | "id"
    | "name"
    | "sectionLabel"
    | "ratePctBps"
    | "rateWithoutPanBps"
    | "annualThresholdPaise"
    | "perTransactionThresholdPaise"
  > | null,
  grossPaise: Paise,
  fyCumulativeBeforePaise: Paise,
  panVerified: boolean,
): TdsComputation {
  if (!rule) {
    return {
      tdsPaise: 0n,
      rateBps: 0,
      thresholdCrossed: false,
      panApplied: panVerified,
      fyCumulativeBeforePaise,
      ruleId: null,
      explanation: "No active tax rule",
    };
  }
  const annualCrossed = fyCumulativeBeforePaise + grossPaise > rule.annualThresholdPaise;
  const perTxnCrossed =
    rule.perTransactionThresholdPaise !== null && grossPaise > rule.perTransactionThresholdPaise;
  const crossed = annualCrossed || perTxnCrossed;
  if (!crossed) {
    return {
      tdsPaise: 0n,
      rateBps: 0,
      thresholdCrossed: false,
      panApplied: panVerified,
      fyCumulativeBeforePaise,
      ruleId: rule.id,
      explanation: `${rule.sectionLabel}: below threshold (FY total ${formatINR(fyCumulativeBeforePaise + grossPaise)} ≤ ${formatINR(rule.annualThresholdPaise)})`,
    };
  }
  const rateBps = panVerified ? rule.ratePctBps : rule.rateWithoutPanBps;
  const tdsPaise = bpsOf(grossPaise, rateBps);
  return {
    tdsPaise,
    rateBps,
    thresholdCrossed: true,
    panApplied: panVerified,
    fyCumulativeBeforePaise,
    ruleId: rule.id,
    explanation:
      `${rule.sectionLabel}: ${(rateBps / 100).toFixed(2)}% ${panVerified ? "" : "(no verified PAN — higher rate) "}` +
      `on ${formatINR(grossPaise)}; FY total ${formatINR(fyCumulativeBeforePaise + grossPaise)} crossed ` +
      (perTxnCrossed && !annualCrossed
        ? `the per-payment threshold ${formatINR(rule.perTransactionThresholdPaise!)}`
        : `the annual threshold ${formatINR(rule.annualThresholdPaise)}`),
  };
}

export async function activeTaxRule(client: DbOrTx, appliesTo: string, at: Date): Promise<TaxRule | null> {
  return client.taxRule.findFirst({
    where: {
      appliesTo,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

/** Gross payouts to a user in the financial year of `at` (excluding failed/rejected). */
export async function fyCumulativeGross(
  client: DbOrTx,
  userId: string,
  at: Date,
  excludePayoutId?: string,
): Promise<Paise> {
  const fy = financialYearOf(at);
  const agg = await client.payout.aggregate({
    where: {
      userId,
      requestedAt: { gte: fy.start, lt: fy.end },
      status: { notIn: ["FAILED", "REVERSED", "REJECTED"] },
      ...(excludePayoutId ? { id: { not: excludePayoutId } } : {}),
    },
    _sum: { grossPaise: true },
  });
  return agg._sum.grossPaise ?? 0n;
}

export async function tdsForPayout(
  client: DbOrTx,
  userId: string,
  grossPaise: Paise,
  at: Date,
  panVerified: boolean,
) {
  const rule = await activeTaxRule(client, "CLIPPER_PAYOUT", at);
  const cumulative = await fyCumulativeGross(client, userId, at);
  return computeTds(rule, grossPaise, cumulative, panVerified);
}

// ---------------------------------------------------------------------------
// Admin: tax rules + statements
// ---------------------------------------------------------------------------

export const taxRuleInputSchema = z.object({
  name: z.string().trim().min(3).max(120),
  appliesTo: z.literal("CLIPPER_PAYOUT"),
  ratePctBps: z.coerce.number().int().min(0).max(5000),
  rateWithoutPanBps: z.coerce.number().int().min(0).max(5000),
  annualThresholdPaise: z.coerce.bigint().min(0n),
  perTransactionThresholdPaise: z.coerce.bigint().min(0n).nullable(),
  sectionLabel: z.string().trim().min(2).max(200),
  notes: z.string().max(2000).optional(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable(),
  active: z.boolean(),
});

export async function upsertTaxRule(
  id: string | null,
  raw: z.input<typeof taxRuleInputSchema>,
  actor: Actor,
) {
  const data = taxRuleInputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const before = id ? await tx.taxRule.findUnique({ where: { id } }) : null;
    const rule = id ? await tx.taxRule.update({ where: { id }, data }) : await tx.taxRule.create({ data });
    await audit(tx, actor, id ? "tax_rule.update" : "tax_rule.create", "TaxRule", rule.id, before, rule);
    return rule;
  });
}

function csvCell(value: string | number | bigint | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | bigint | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

const rupeesCell = (p: Paise) => formatINR(p, { noSymbol: true, alwaysShowPaise: true }).replace(/,/g, "");

/** Per-clipper annual earnings and TDS statement for a financial year (admin CSV). */
export async function annualTdsStatementCsv(fyStartYear: number): Promise<string> {
  const { start, end, label } = financialYearOf(new Date(Date.UTC(fyStartYear, 6, 1)));
  const payouts = await db.payout.findMany({
    where: { requestedAt: { gte: start, lt: end }, status: "PAID" },
    include: { user: { include: { payoutProfile: true } } },
  });
  const byUser = new Map<
    string,
    { name: string; email: string; pan: string; gross: Paise; tds: Paise; net: Paise; count: number }
  >();
  for (const p of payouts) {
    const row = byUser.get(p.userId) ?? {
      name: p.user.payoutProfile?.legalName ?? p.user.name ?? "",
      email: p.user.email,
      pan: p.user.payoutProfile?.maskedPan ?? "NOT PROVIDED",
      gross: 0n,
      tds: 0n,
      net: 0n,
      count: 0,
    };
    row.gross += p.grossPaise;
    row.tds += p.tdsPaise;
    row.net += p.netPaise;
    row.count += 1;
    byUser.set(p.userId, row);
  }
  const rows: (string | number)[][] = [
    [
      "financial_year",
      "user_id",
      "legal_name",
      "email",
      "pan_masked",
      "payouts",
      "gross_inr",
      "tds_inr",
      "net_inr",
    ],
  ];
  for (const [userId, r] of byUser) {
    rows.push([
      label,
      userId,
      r.name,
      r.email,
      r.pan,
      r.count,
      rupeesCell(r.gross),
      rupeesCell(r.tds),
      rupeesCell(r.net),
    ]);
  }
  return toCsv(rows);
}
