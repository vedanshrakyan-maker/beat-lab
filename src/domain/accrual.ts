import type { Campaign, Submission } from "@prisma/client";
import { audit, systemActor } from "@/lib/audit";
import type { DbOrTx } from "@/lib/db";
import { bpsOf, earningsForViews, formatINR, minPaise, viewsForAmount, type Paise } from "@/lib/money";
import { getSetting } from "@/lib/settings";
import { acct, balance, credit, debit, post } from "@/ledger/ledger";
import { lockCampaign, notifyOrgMembers, transitionCampaign } from "@/domain/campaigns";
import { notify } from "@/domain/notifications";

/** Statuses whose earnings may still grow. FLAGGED submissions are frozen. */
export const ACCRUING_STATUSES = ["APPROVED", "TRACKING", "LOCKED"] as const;

/** View count at which the per-submission cap is reached (null = uncapped). */
export function capViewsFor(
  c: Pick<Campaign, "maxPayoutPerSubmissionPaise" | "ratePer1kViewsPaise">,
): number | null {
  if (!c.maxPayoutPerSubmissionPaise) return null;
  return Number(viewsForAmount(c.maxPayoutPerSubmissionPaise, c.ratePer1kViewsPaise));
}

/** Target earnings for a view count, before the budget and per-clipper caps. */
export function targetEarnings(
  c: Pick<Campaign, "ratePer1kViewsPaise" | "maxPayoutPerSubmissionPaise" | "minViewsToQualify">,
  views: number,
): Paise {
  if (views < c.minViewsToQualify) return 0n;
  const raw = earningsForViews(views, c.ratePer1kViewsPaise);
  return c.maxPayoutPerSubmissionPaise ? minPaise(raw, c.maxPayoutPerSubmissionPaise) : raw;
}

export interface AccrualResult {
  grantedPaise: Paise;
  targetPaise: Paise;
  limitedBy: "none" | "budget" | "clipper_cap" | "already_accrued" | "not_accruing" | "duplicate";
}

/**
 * Reserve earnings for a submission up to `views`. Moves only the DELTA from
 * campaign_budget -> campaign_reserved, capped by the remaining budget, inside the
 * caller's transaction and under a row lock on the campaign (SELECT ... FOR UPDATE), so
 * concurrent accruals are serialized and the budget can never go negative.
 * Allocation is first-come-first-served by accrual time (see docs/LEDGER.md).
 */
export async function accrue(
  tx: DbOrTx,
  submissionId: string,
  views: number,
  idempotencyKey: string,
  options: { allowStatuses?: readonly string[] } = {},
): Promise<AccrualResult> {
  const pre = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { campaignId: true },
  });
  await lockCampaign(tx, pre.campaignId);
  await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
  const sub = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { campaign: true },
  });
  const c = sub.campaign;

  const target = targetEarnings(c, views);
  const allowed = options.allowStatuses ?? ACCRUING_STATUSES;
  if (!allowed.includes(sub.status))
    return { grantedPaise: 0n, targetPaise: target, limitedBy: "not_accruing" };

  const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } });
  if (existing) return { grantedPaise: 0n, targetPaise: target, limitedBy: "duplicate" };

  let wanted = target - sub.earnedPaise;
  if (wanted <= 0n) return { grantedPaise: 0n, targetPaise: target, limitedBy: "already_accrued" };

  let limitedBy: AccrualResult["limitedBy"] = "none";
  if (c.maxPayoutPerClipperPaise) {
    const others = await tx.submission.aggregate({
      where: { campaignId: c.id, clipperId: sub.clipperId, id: { not: sub.id } },
      _sum: { earnedPaise: true },
    });
    const room = c.maxPayoutPerClipperPaise - (others._sum.earnedPaise ?? 0n) - sub.earnedPaise;
    if (room < wanted) {
      wanted = room > 0n ? room : 0n;
      limitedBy = "clipper_cap";
    }
  }

  const remaining = await balance(tx, acct.campaignBudget(c.id));
  let grant = wanted;
  if (remaining < grant) {
    grant = remaining > 0n ? remaining : 0n;
    limitedBy = "budget";
  }
  if (grant > 0n) {
    await post(tx, {
      idempotencyKey,
      kind: "ACCRUAL",
      description: `Earnings for ${views.toLocaleString("en-IN")} views`,
      campaignId: c.id,
      submissionId: sub.id,
      userId: sub.clipperId,
      entries: [debit(acct.campaignBudget(c.id), grant), credit(acct.campaignReserved(c.id), grant)],
      metadata: { views, targetPaise: target.toString() },
    });
    await tx.submission.update({ where: { id: sub.id }, data: { earnedPaise: { increment: grant } } });
  }

  const after = remaining - grant;
  await budgetAlerts(tx, c, after);
  return { grantedPaise: grant, targetPaise: target, limitedBy };
}

/** Low-budget and exhausted notifications + ACTIVE -> EXHAUSTED transition. */
async function budgetAlerts(tx: DbOrTx, c: Campaign, remaining: Paise) {
  if (remaining <= 0n && c.status === "ACTIVE") {
    await transitionCampaign(tx, c.id, "EXHAUSTED", systemActor, "Budget fully reserved");
    const vars = { campaign: c.title };
    await notifyOrgMembers(tx, c.organizationId, "BUDGET_EXHAUSTED", vars, `/funder/campaigns/${c.id}`);
    const participants = await tx.campaignParticipation.findMany({
      where: { campaignId: c.id, status: "ACTIVE" },
    });
    for (const p of participants)
      await notify(tx, p.clipperId, "BUDGET_EXHAUSTED", vars, `/campaigns/${c.id}`);
    return;
  }
  if (c.lowBudgetNotifiedAt || remaining <= 0n) return;
  const { lowBudgetAlertBps } = await getSetting("payouts", tx);
  if (remaining <= bpsOf(c.budgetPaise, lowBudgetAlertBps)) {
    await tx.campaign.update({ where: { id: c.id }, data: { lowBudgetNotifiedAt: new Date() } });
    await notifyOrgMembers(
      tx,
      c.organizationId,
      "BUDGET_LOW",
      { campaign: c.title, remaining: formatINR(remaining) },
      `/funder/campaigns/${c.id}`,
    );
  }
}

/**
 * Return reserved earnings to the budget (void, or payout reduced after a view drop).
 * Re-activates an EXHAUSTED campaign whose budget comes back.
 */
export async function releaseReserved(
  tx: DbOrTx,
  sub: Pick<Submission, "id" | "campaignId" | "clipperId">,
  amount: Paise,
  idempotencyKey: string,
  description: string,
): Promise<void> {
  if (amount <= 0n) return;
  const { created } = await post(tx, {
    idempotencyKey,
    kind: "RELEASE",
    description,
    campaignId: sub.campaignId,
    submissionId: sub.id,
    userId: sub.clipperId,
    entries: [
      debit(acct.campaignReserved(sub.campaignId), amount),
      credit(acct.campaignBudget(sub.campaignId), amount),
    ],
  });
  if (!created) return;
  await tx.submission.update({ where: { id: sub.id }, data: { earnedPaise: { decrement: amount } } });
  await reactivateIfBudgetReturned(tx, sub.campaignId);
}

export async function reactivateIfBudgetReturned(tx: DbOrTx, campaignId: string) {
  const c = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (c.status !== "EXHAUSTED") return;
  if (c.endsAt && c.endsAt <= new Date()) return;
  const remaining = await balance(tx, acct.campaignBudget(campaignId));
  if (remaining > 0n) {
    await transitionCampaign(tx, campaignId, "ACTIVE", systemActor, "Budget returned by a voided submission");
    await audit(tx, systemActor, "campaign.budget_returned", "Campaign", campaignId, undefined, {
      remaining,
    });
  }
}
