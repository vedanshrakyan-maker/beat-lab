import type { Campaign, CampaignStatus, Platform, Prisma } from "@prisma/client";
import { z } from "zod";
import { audit, systemActor, type Actor } from "@/lib/audit";
import { db, type DbOrTx, type Tx } from "@/lib/db";
import { formatINR, type Paise } from "@/lib/money";
import { acct, balance, balances, credit, debit, post } from "@/ledger/ledger";
import { notify } from "@/domain/notifications";

// ---------------------------------------------------------------------------
// Rules (structured JSON on the campaign)
// ---------------------------------------------------------------------------

const tag = (prefix: "#" | "@") =>
  z
    .string()
    .trim()
    .min(2)
    .max(60)
    .transform((v) => (v.startsWith(prefix) ? v : `${prefix}${v}`))
    .refine((v) => /^[#@][\p{L}\p{N}_.]+$/u.test(v), "Letters, numbers, _ and . only");

export const campaignRulesSchema = z.object({
  requiredHashtags: z.array(tag("#")).max(10).default([]),
  requiredMentions: z.array(tag("@")).max(5).default([]),
  minDurationSec: z.number().int().min(0).max(600).nullable().default(null),
  maxDurationSec: z.number().int().min(1).max(600).nullable().default(null),
  languages: z.array(z.string().trim().min(2).max(30)).max(10).default([]),
  disallowedContent: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
  allowFanPages: z.boolean().default(true),
  notes: z.string().max(2000).optional(),
});
export type CampaignRules = z.infer<typeof campaignRulesSchema>;

export function parseRules(value: Prisma.JsonValue): CampaignRules {
  return campaignRulesSchema.parse(value ?? {});
}

// ---------------------------------------------------------------------------
// Create / validate
// ---------------------------------------------------------------------------

const paise = (min: bigint, max: bigint, label: string) =>
  z
    .bigint()
    .refine((v) => v >= min && v <= max, `${label} must be between ${formatINR(min)} and ${formatINR(max)}`);

export const campaignInputSchema = z
  .object({
    organizationId: z.string().min(1),
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().min(10).max(5000),
    category: z.string().trim().min(2).max(40).default("General"),
    type: z.enum(["CLIPPING", "UGC"]),
    sourceContentUrls: z.array(z.string().url()).max(10).default([]),
    rules: campaignRulesSchema,
    allowedPlatforms: z.array(z.enum(["INSTAGRAM", "YOUTUBE"])).min(1),
    ratePer1kViewsPaise: paise(100n, 1_000_00n, "Rate per 1K views"),
    budgetPaise: paise(1_000_00n, 1_00_00_000_00n, "Budget"),
    platformFeeBps: z.number().int().min(0).max(5000),
    gstOnFeeBps: z.number().int().min(0).max(5000),
    maxPayoutPerSubmissionPaise: z.bigint().positive().nullable().default(null),
    maxPayoutPerClipperPaise: z.bigint().positive().nullable().default(null),
    minViewsToQualify: z.number().int().min(0).max(10_000_000).default(0),
    trackingWindowDays: z.number().int().min(1).max(30),
    holdPeriodDays: z.number().int().min(0).max(30),
    startsAt: z.date().nullable().default(null),
    endsAt: z.date().nullable().default(null),
    isManaged: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.type === "CLIPPING" && c.sourceContentUrls.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceContentUrls"],
        message: "Clipping campaigns need source content to clip",
      });
    }
    if (c.maxPayoutPerSubmissionPaise && c.maxPayoutPerSubmissionPaise > c.budgetPaise) {
      ctx.addIssue({
        code: "custom",
        path: ["maxPayoutPerSubmissionPaise"],
        message: "Cannot exceed the budget",
      });
    }
    if (
      c.maxPayoutPerClipperPaise &&
      c.maxPayoutPerSubmissionPaise &&
      c.maxPayoutPerClipperPaise < c.maxPayoutPerSubmissionPaise
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxPayoutPerClipperPaise"],
        message: "Per-clipper cap must be ≥ per-submission cap",
      });
    }
    if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after start date" });
    }
    const r = c.rules;
    if (r.minDurationSec && r.maxDurationSec && r.maxDurationSec < r.minDurationSec) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", "maxDurationSec"],
        message: "Max duration must be ≥ min duration",
      });
    }
  });
export type CampaignInput = z.input<typeof campaignInputSchema>;

export async function createCampaign(
  input: CampaignInput,
  createdById: string,
  actor: Actor,
): Promise<Campaign> {
  const data = campaignInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        ...data,
        rules: data.rules as Prisma.InputJsonValue,
        allowedPlatforms: data.allowedPlatforms as Platform[],
        createdById,
        status: "DRAFT",
      },
    });
    await audit(
      tx,
      actor,
      data.isManaged ? "campaign.create_managed" : "campaign.create",
      "Campaign",
      campaign.id,
      undefined,
      campaign,
    );
    return campaign;
  });
}

export async function updateDraftCampaign(
  campaignId: string,
  input: CampaignInput,
  actor: Actor,
): Promise<Campaign> {
  const data = campaignInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (before.status !== "DRAFT") throw new CampaignError("Only draft campaigns can be edited");
    const after = await tx.campaign.update({
      where: { id: campaignId },
      data: {
        ...data,
        rules: data.rules as Prisma.InputJsonValue,
        allowedPlatforms: data.allowedPlatforms as Platform[],
      },
    });
    await audit(tx, actor, "campaign.update", "Campaign", campaignId, before, after);
    return after;
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class CampaignError extends Error {}

export const campaignTransitions: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ["PENDING_FUNDING"],
  PENDING_FUNDING: ["ACTIVE", "DRAFT"],
  ACTIVE: ["PAUSED", "EXHAUSTED", "ENDED"],
  PAUSED: ["ACTIVE", "ENDED"],
  EXHAUSTED: ["ACTIVE", "ENDED"],
  ENDED: ["SETTLED"],
  SETTLED: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return campaignTransitions[from].includes(to);
}

/** Validated, audited status change. Call inside a transaction. */
export async function transitionCampaign(
  tx: DbOrTx,
  campaignId: string,
  to: CampaignStatus,
  actor: Actor,
  reason?: string,
): Promise<Campaign> {
  const before = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (before.status === to) return before;
  if (!canTransition(before.status, to)) {
    throw new CampaignError(`Campaign cannot move from ${before.status} to ${to}`);
  }
  const now = new Date();
  const after = await tx.campaign.update({
    where: { id: campaignId },
    data: {
      status: to,
      activatedAt: to === "ACTIVE" && !before.activatedAt ? now : undefined,
      endedAt: to === "ENDED" ? now : undefined,
    },
  });
  await audit(
    tx,
    actor,
    `campaign.status.${to.toLowerCase()}`,
    "Campaign",
    campaignId,
    { status: before.status },
    { status: to, reason },
  );
  return after;
}

/** Campaigns clippers can join and submit to. */
export function acceptsSubmissions(
  c: Pick<Campaign, "status" | "startsAt" | "endsAt">,
  now = new Date(),
): boolean {
  if (c.status !== "ACTIVE") return false;
  if (c.startsAt && c.startsAt > now) return false;
  if (c.endsAt && c.endsAt <= now) return false;
  return true;
}

export async function pauseCampaign(campaignId: string, actor: Actor) {
  return db.$transaction((tx) => transitionCampaign(tx, campaignId, "PAUSED", actor));
}

export async function resumeCampaign(campaignId: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const remaining = await balance(tx, acct.campaignBudget(campaignId));
    return transitionCampaign(tx, campaignId, remaining > 0n ? "ACTIVE" : "EXHAUSTED", actor);
  });
}

export async function endCampaign(campaignId: string, actor: Actor, reason = "Ended manually") {
  return db.$transaction((tx) => transitionCampaign(tx, campaignId, "ENDED", actor, reason));
}

// ---------------------------------------------------------------------------
// Money views
// ---------------------------------------------------------------------------

export interface CampaignMoney {
  budgetPaise: Paise;
  remainingPaise: Paise;
  reservedPaise: Paise;
  /** Cleared to clippers (payable or already paid), net of clawbacks. */
  clearedPaise: Paise;
  spentPaise: Paise;
  refundedPaise: Paise;
}

export async function campaignMoney(
  client: DbOrTx,
  campaign: Pick<Campaign, "id" | "budgetPaise">,
): Promise<CampaignMoney> {
  const map = await balances(client, [acct.campaignBudget(campaign.id), acct.campaignReserved(campaign.id)]);
  const remaining = map.get(acct.campaignBudget(campaign.id)) ?? 0n;
  const reserved = map.get(acct.campaignReserved(campaign.id)) ?? 0n;
  const rows = await client.$queryRaw<{ cleared: bigint | null; refunded: bigint | null }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN a.kind = 'clipper_payable' THEN -e."amountPaise" END), 0)::bigint AS cleared,
      COALESCE(SUM(CASE WHEN a.kind = 'refund_payable' AND t.kind = 'CAMPAIGN_END' THEN -e."amountPaise" END), 0)::bigint AS refunded
    FROM "LedgerEntry" e
    JOIN "LedgerTransaction" t ON t.id = e."transactionId"
    JOIN "LedgerAccount" a ON a.id = e."accountId"
    WHERE t."campaignId" = ${campaign.id}
      AND t.kind IN ('CLEARING', 'CLAWBACK', 'CAMPAIGN_END')`;
  const cleared = rows[0]?.cleared ?? 0n;
  return {
    budgetPaise: campaign.budgetPaise,
    remainingPaise: remaining,
    reservedPaise: reserved,
    clearedPaise: cleared,
    spentPaise: reserved + cleared,
    refundedPaise: rows[0]?.refunded ?? 0n,
  };
}

// ---------------------------------------------------------------------------
// End & settle (worker sweeps)
// ---------------------------------------------------------------------------

const FINAL_SUBMISSION_STATUSES = ["PAYABLE", "PAID", "REJECTED", "VOIDED", "CLAWED_BACK"] as const;

/** Move campaigns whose end date passed to ENDED. */
export async function endExpiredCampaigns(now = new Date()): Promise<number> {
  const expired = await db.campaign.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "EXHAUSTED"] }, endsAt: { lte: now } },
    select: { id: true },
  });
  for (const c of expired) {
    await db.$transaction((tx) => transitionCampaign(tx, c.id, "ENDED", systemActor, "End date reached"));
  }
  return expired.length;
}

/**
 * ENDED campaigns whose submissions are all final get their unused budget moved to
 * refund_payable and become SETTLED. Also sweeps budget that returns to a SETTLED
 * campaign later (e.g. a clawback). Refunds themselves are an admin action in v0.1.
 */
export async function settleCampaigns(): Promise<number> {
  const candidates = await db.campaign.findMany({
    where: { status: { in: ["ENDED", "SETTLED"] } },
    select: { id: true, status: true, organizationId: true, title: true },
  });
  let settled = 0;
  for (const c of candidates) {
    const open = await db.submission.count({
      where: { campaignId: c.id, status: { notIn: [...FINAL_SUBMISSION_STATUSES] } },
    });
    if (open > 0) continue;
    await db.$transaction(async (tx) => {
      await lockCampaign(tx, c.id);
      const remaining = await balance(tx, acct.campaignBudget(c.id));
      if (remaining > 0n) {
        const n = await tx.ledgerTransaction.count({ where: { campaignId: c.id, kind: "CAMPAIGN_END" } });
        await post(tx, {
          idempotencyKey: `campaign_end:${c.id}:${n}`,
          kind: "CAMPAIGN_END",
          description: `Unused budget of “${c.title}” to refund payable`,
          campaignId: c.id,
          entries: [
            debit(acct.campaignBudget(c.id), remaining),
            credit(acct.refundPayable(c.organizationId), remaining),
          ],
        });
      }
      if (c.status === "ENDED") {
        await transitionCampaign(tx, c.id, "SETTLED", systemActor, "All submissions final");
        settled++;
      }
    });
  }
  return settled;
}

/** Admin action: record that refund_payable was returned to the funder. */
export async function recordRefund(organizationId: string, actor: Actor): Promise<Paise> {
  return db.$transaction(async (tx) => {
    const code = acct.refundPayable(organizationId);
    const amount = await balance(tx, code);
    if (amount <= 0n) return 0n;
    const n = await tx.ledgerTransaction.count({
      where: { kind: "REFUND_PAID", metadata: { path: ["organizationId"], equals: organizationId } },
    });
    await post(tx, {
      idempotencyKey: `refund:${organizationId}:${n}`,
      kind: "REFUND_PAID",
      description: "Unused budget refunded to funder",
      entries: [debit(code, amount), credit(acct.funderCashIn(), amount)],
      metadata: { organizationId },
    });
    await audit(tx, actor, "refund.record", "Organization", organizationId, undefined, {
      amountPaise: amount,
    });
    return amount;
  });
}

/** Row lock that serializes every money movement touching one campaign's budget. */
export async function lockCampaign(tx: Tx | DbOrTx, campaignId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;
}

export async function notifyOrgMembers(
  tx: DbOrTx,
  organizationId: string,
  kind: Parameters<typeof notify>[2],
  vars: Record<string, string | number>,
  href?: string,
) {
  const members = await tx.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true },
  });
  for (const m of members) await notify(tx, m.userId, kind, vars, href);
}
