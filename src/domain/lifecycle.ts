import type { Platform, Prisma, Submission, SubmissionStatus } from "@prisma/client";
import { audit, systemActor, type Actor } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { db, type DbOrTx } from "@/lib/db";
import { formatINR, minPaise } from "@/lib/money";
import { getSetting, type PollingSettings } from "@/lib/settings";
import { acct, balance, credit, debit, post } from "@/ledger/ledger";
import type { FraudEvaluation } from "@/fraud/types";
import { getAdapter } from "@/platforms";
import {
  chunk,
  type MetricResult,
  type PlatformAdapter,
  type PostExistence,
  type PostRef,
} from "@/platforms/types";
import {
  accrue,
  capViewsFor,
  reactivateIfBudgetReturned,
  releaseReserved,
  targetEarnings,
} from "@/domain/accrual";
import { lockCampaign, parseRules } from "@/domain/campaigns";
import { refreshUserRisk, runFraud } from "@/domain/fraud-context";
import { notify } from "@/domain/notifications";
import { addDays, SLOT_HOLD_END, SLOT_LOCK, snapshotDueAt } from "@/domain/schedule";

/**
 * Submission lifecycle after approval (Section 6.5):
 *   TRACKING --(snapshots on schedule, accrual, fraud)--> LOCKED -> HELD --(re-check)--> PAYABLE
 * Every step is idempotent and safe to retry: each runs in one DB transaction under row
 * locks (campaign, then submission — always in that order) and re-checks state after locking.
 */

export interface RunOptions {
  now?: Date;
  /** Override adapters (seed / fast-forward use a MockAdapter with a virtual clock). */
  adapterFor?: (platform: Platform) => PlatformAdapter;
  submissionIds?: string[];
  limit?: number;
}

type SubWithRefs = Prisma.SubmissionGetPayload<{ include: { socialAccount: true; campaign: true } }>;

export const REVIEWABLE_STATUSES: SubmissionStatus[] = [
  "UNDER_REVIEW",
  "FLAGGED",
  "TRACKING",
  "LOCKED",
  "HELD",
];

function adapterFactory(opts: RunOptions, polling: PollingSettings, now: Date) {
  const cache = new Map<Platform, PlatformAdapter>();
  return (platform: Platform) => {
    if (!cache.has(platform)) {
      cache.set(
        platform,
        opts.adapterFor?.(platform) ??
          getAdapter(platform, { now: () => now, youtubeQuotaStopBps: polling.youtubeQuotaStopBps }),
      );
    }
    return cache.get(platform)!;
  };
}

export function postRefFor(sub: SubWithRefs): PostRef {
  const rules = parseRules(sub.campaign.rules);
  return {
    submissionId: sub.id,
    platformPostId: sub.platformPostId,
    platformMediaId: sub.platformMediaId,
    accessToken: sub.socialAccount.encryptedAccessToken
      ? decrypt(sub.socialAccount.encryptedAccessToken)
      : null,
    platformAccountId: sub.socialAccount.platformAccountId,
    publishedAt: sub.submittedAt,
    mock: {
      scenario: sub.mockScenario,
      capViews: capViewsFor(sub.campaign),
      captionTags: [...rules.requiredHashtags, ...rules.requiredMentions],
    },
  };
}

async function lockSubmission(tx: DbOrTx, sub: Pick<Submission, "id" | "campaignId">): Promise<Submission> {
  await lockCampaign(tx, sub.campaignId);
  await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${sub.id} FOR UPDATE`;
  return tx.submission.findUniqueOrThrow({ where: { id: sub.id } });
}

export async function setStatus(
  tx: DbOrTx,
  sub: Pick<Submission, "id" | "status">,
  to: SubmissionStatus,
  actor: Actor,
  data: Prisma.SubmissionUpdateInput = {},
  reason?: string,
): Promise<void> {
  await tx.submission.update({ where: { id: sub.id }, data: { ...data, status: to } });
  await audit(
    tx,
    actor,
    `submission.status.${to.toLowerCase()}`,
    "Submission",
    sub.id,
    { status: sub.status },
    { status: to, reason },
  );
}

async function saveSnapshot(
  tx: DbOrTx,
  submissionId: string,
  slot: number,
  m: Extract<MetricResult, { ok: true }>,
  now: Date,
) {
  const exists = await tx.metricSnapshot.findUnique({ where: { submissionId_slot: { submissionId, slot } } });
  if (exists) return exists;
  return tx.metricSnapshot.create({
    data: {
      submissionId,
      slot,
      capturedAt: now,
      views: m.views,
      reach: m.reach,
      likes: m.likes,
      comments: m.comments,
      shares: m.shares,
      saves: m.saves,
      source: m.source,
      rawPayload: m.raw as Prisma.InputJsonValue,
    },
  });
}

// ---------------------------------------------------------------------------
// Fraud decisions
// ---------------------------------------------------------------------------

function topExplanation(evaluation: FraudEvaluation): string {
  return (
    [...evaluation.signals].sort((a, b) => b.score * b.weight - a.score * a.weight)[0]?.explanation ??
    "Fraud checks failed"
  );
}

/** Apply the engine's decision to a (locked) submission. */
export async function applyFraudDecision(
  tx: DbOrTx,
  submissionId: string,
  evaluation: FraudEvaluation,
  actor: Actor,
  now: Date,
) {
  const sub = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { campaign: true },
  });
  const reflagAllowed = sub.reviewState !== "CLEARED" || evaluation.score > (sub.reviewClearedScore ?? 0);
  const vars = { campaign: sub.campaign.title, reason: topExplanation(evaluation) };

  switch (evaluation.decision) {
    case "AUTO_VOID":
      await voidSubmission(tx, submissionId, topExplanation(evaluation), actor, now);
      return;
    case "AUTO_REJECT":
      if (sub.status === "SUBMITTED" || sub.status === "UNDER_REVIEW") {
        await setStatus(
          tx,
          sub,
          "REJECTED",
          actor,
          { rejectionReason: vars.reason, nextSnapshotAt: null },
          vars.reason,
        );
        await notify(tx, sub.clipperId, "SUBMISSION_REJECTED", vars, `/clipper/submissions/${sub.id}`);
        return;
      }
      if (!reflagAllowed || sub.status === "FLAGGED") return;
      await flag(tx, sub, actor, vars);
      return;
    case "AUTO_FLAG":
      if (!reflagAllowed || sub.status === "FLAGGED") return;
      if (sub.status === "SUBMITTED" || sub.status === "UNDER_REVIEW") {
        await tx.submission.update({ where: { id: sub.id }, data: { reviewState: "NEEDS_REVIEW" } });
        return;
      }
      if (["APPROVED", "TRACKING", "LOCKED", "HELD"].includes(sub.status)) await flag(tx, sub, actor, vars);
      return;
    case "MANUAL_REVIEW":
      if (!reflagAllowed || sub.reviewState === "NEEDS_REVIEW") return;
      await tx.submission.update({ where: { id: sub.id }, data: { reviewState: "NEEDS_REVIEW" } });
      await audit(tx, actor, "submission.review_requested", "Submission", sub.id, undefined, {
        score: evaluation.score,
      });
      await notify(tx, sub.clipperId, "SUBMISSION_UNDER_REVIEW", vars, `/clipper/submissions/${sub.id}`);
      return;
    case "AUTO_APPROVE":
      return;
  }
}

async function flag(tx: DbOrTx, sub: Submission, actor: Actor, vars: { campaign: string; reason: string }) {
  await setStatus(
    tx,
    sub,
    "FLAGGED",
    actor,
    { statusBeforeFlag: sub.status, reviewState: "NEEDS_REVIEW" },
    vars.reason,
  );
  await notify(tx, sub.clipperId, "SUBMISSION_UNDER_REVIEW", vars, `/clipper/submissions/${sub.id}`);
  await refreshUserRisk(tx, sub.clipperId);
}

/**
 * Void a submission. Reserved earnings return to the budget. If the earnings were already
 * cleared (PAYABLE) or paid (PAID), they are clawed back from clipper_payable (which may go
 * negative and is offset against future earnings) and the clipper is flagged.
 */
export async function voidSubmission(
  tx: DbOrTx,
  submissionId: string,
  reason: string,
  actor: Actor,
  now = new Date(),
) {
  const pre = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { id: true, campaignId: true },
  });
  const sub = await lockSubmission(tx, pre);
  if (["VOIDED", "CLAWED_BACK", "REJECTED"].includes(sub.status)) return;
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: sub.campaignId } });
  const vars = { campaign: campaign.title, reason };

  if (sub.status === "PAYABLE" || sub.status === "PAID") {
    const amount = sub.earnedPaise;
    if (amount > 0n) {
      await post(tx, {
        idempotencyKey: `clawback:${sub.id}`,
        kind: "CLAWBACK",
        description: `Clawback: ${reason}`,
        campaignId: sub.campaignId,
        submissionId: sub.id,
        userId: sub.clipperId,
        entries: [
          debit(acct.clipperPayable(sub.clipperId), amount),
          credit(acct.campaignBudget(sub.campaignId), amount),
        ],
      });
    }
    await setStatus(
      tx,
      sub,
      "CLAWED_BACK",
      actor,
      { earnedPaise: 0n, rejectionReason: reason, voidedAt: now, nextSnapshotAt: null },
      reason,
    );
    const walletAfter = await balance(tx, acct.clipperPayable(sub.clipperId));
    if (sub.status === "PAID" || walletAfter < 0n) {
      const flagReason = `Clawback of ${formatINR(amount)} on a ${sub.status === "PAID" ? "paid" : "cleared"} submission (${reason})`;
      await tx.user.update({ where: { id: sub.clipperId }, data: { flaggedAt: now, flagReason } });
      await audit(tx, actor, "user.flagged", "User", sub.clipperId, undefined, {
        reason: flagReason,
        walletAfter,
      });
      await notify(tx, sub.clipperId, "ACCOUNT_FLAGGED", { reason: flagReason }, "/clipper/wallet");
    }
    await reactivateIfBudgetReturned(tx, sub.campaignId);
  } else {
    await releaseReserved(tx, sub, sub.earnedPaise, `void:${sub.id}`, `Void: ${reason}`);
    await setStatus(
      tx,
      sub,
      "VOIDED",
      actor,
      { rejectionReason: reason, voidedAt: now, nextSnapshotAt: null },
      reason,
    );
  }
  await notify(tx, sub.clipperId, "SUBMISSION_REJECTED", vars, `/clipper/submissions/${sub.id}`);
  await refreshUserRisk(tx, sub.clipperId);
}

// ---------------------------------------------------------------------------
// Tracking: scheduled snapshots
// ---------------------------------------------------------------------------

export async function startTracking(tx: DbOrTx, submissionId: string, actor: Actor, now: Date) {
  const sub = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { campaign: true },
  });
  await setStatus(tx, sub, "APPROVED", actor, { approvedAt: now });
  const started = sub.trackingStartedAt ?? now;
  await setStatus(tx, { id: sub.id, status: "APPROVED" }, "TRACKING", actor, {
    trackingStartedAt: started,
    trackingEndsAt: sub.trackingEndsAt ?? addDays(started, sub.campaign.trackingWindowDays),
  });
  await notify(
    tx,
    sub.clipperId,
    "SUBMISSION_APPROVED",
    { campaign: sub.campaign.title },
    `/clipper/submissions/${sub.id}`,
  );
}

/** Poll every submission whose next snapshot is due, batched per platform. */
export async function pollDueSnapshots(opts: RunOptions = {}): Promise<{ captured: number; failed: number }> {
  const now = opts.now ?? new Date();
  const polling = await getSetting("polling");
  const adapterFor = adapterFactory(opts, polling, now);
  const due = await db.submission.findMany({
    where: {
      nextSnapshotAt: { lte: now },
      status: { in: ["TRACKING", "UNDER_REVIEW", "FLAGGED"] },
      metricsSource: { not: "UNAVAILABLE" },
      ...(opts.submissionIds ? { id: { in: opts.submissionIds } } : {}),
    },
    include: { socialAccount: true, campaign: true },
    orderBy: { nextSnapshotAt: "asc" },
    take: opts.limit ?? 1000,
  });
  let captured = 0;
  let failed = 0;
  const byPlatform = new Map<Platform, SubWithRefs[]>();
  for (const s of due) byPlatform.set(s.platform, [...(byPlatform.get(s.platform) ?? []), s]);

  for (const [platform, subs] of byPlatform) {
    const adapter = adapterFor(platform);
    for (const batch of chunk(subs, adapter.batchSize)) {
      let results: Map<string, MetricResult>;
      try {
        results = await adapter.fetchPostMetrics(batch.map(postRefFor));
      } catch (e) {
        failed += batch.length;
        console.error(`[poll] ${platform} batch failed`, e instanceof Error ? e.message : e);
        continue;
      }
      let quotaHit = false;
      for (const sub of batch) {
        const result = results.get(sub.platformPostId) ?? { ok: false, error: "ERROR", message: "No result" };
        if (!result.ok && result.error === "QUOTA_EXCEEDED") quotaHit = true;
        const ok = await handleScheduledMetric(sub, sub.nextSnapshotSlot, result, now, polling);
        if (ok) captured++;
        else failed++;
      }
      if (quotaHit) {
        await recordQuotaAlert(platform, now);
        break; // stop polling this platform gracefully; the next sweep retries
      }
    }
  }
  return { captured, failed };
}

async function recordQuotaAlert(platform: Platform, now: Date) {
  const since = new Date(now.getTime() - 6 * 3_600_000);
  const recent = await db.healthCheck.findFirst({
    where: { kind: "QUOTA_ALERT", createdAt: { gte: since } },
  });
  if (recent) return;
  await db.healthCheck.create({
    data: { kind: "QUOTA_ALERT", ok: false, details: { platform, at: now.toISOString() }, createdAt: now },
  });
  console.warn(`[poll] ${platform} API quota nearly exhausted — polling paused until reset`);
}

async function handleScheduledMetric(
  sub: SubWithRefs,
  slot: number,
  result: MetricResult,
  now: Date,
  polling: PollingSettings,
): Promise<boolean> {
  return db.$transaction(
    async (tx) => {
      const locked = await lockSubmission(tx, sub);
      if (locked.nextSnapshotSlot !== slot || !locked.nextSnapshotAt) return false; // processed elsewhere
      let ok = false;
      if (result.ok) {
        const snap = await saveSnapshot(tx, sub.id, slot, result, now);
        await tx.submission.update({
          where: { id: sub.id },
          data: {
            caption: result.caption ?? undefined,
            platformMediaId: result.platformMediaId ?? undefined,
          },
        });
        const evaluation = await runFraud(tx, sub.id, "SNAPSHOT", now);
        await applyFraudDecision(tx, sub.id, evaluation, systemActor, now);
        await accrue(tx, sub.id, snap.views, `accrual:${sub.id}:${slot}`);
        ok = true;
      } else if (result.error === "INSIGHTS_UNAVAILABLE") {
        await routeToManual(tx, locked, result.message);
        return false;
      } else if (result.error === "TOKEN_REVOKED") {
        await disconnectAccount(tx, sub.socialAccountId, result.message);
      } else if (result.error === "QUOTA_EXCEEDED" || result.error === "ERROR") {
        return false; // do not advance: retried on the next sweep
      }
      // NOT_FOUND / TOKEN_REVOKED: skip this slot; the lock re-check decides.
      const start = locked.trackingStartedAt ?? locked.submittedAt;
      const next = snapshotDueAt(start, slot + 1, sub.campaign.trackingWindowDays, polling);
      const endsAt = locked.trackingEndsAt ?? addDays(start, sub.campaign.trackingWindowDays);
      await tx.submission.update({
        where: { id: sub.id },
        data: { nextSnapshotSlot: slot + 1, nextSnapshotAt: next && next < endsAt ? next : null },
      });
      return ok;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** API metrics unavailable: route to the manual-verification queue (Section 6.4). */
export async function routeToManual(
  tx: DbOrTx,
  sub: Pick<Submission, "id" | "status" | "clipperId" | "campaignId">,
  message: string,
) {
  await tx.submission.update({
    where: { id: sub.id },
    data: { metricsSource: "UNAVAILABLE", reviewState: "NEEDS_REVIEW", nextSnapshotAt: null },
  });
  await audit(tx, systemActor, "submission.metrics_unavailable", "Submission", sub.id, undefined, {
    message,
  });
  const c = await tx.campaign.findUniqueOrThrow({ where: { id: sub.campaignId }, select: { title: true } });
  await notify(
    tx,
    sub.clipperId,
    "SUBMISSION_UNDER_REVIEW",
    { campaign: c.title },
    `/clipper/submissions/${sub.id}`,
  );
}

export async function disconnectAccount(tx: DbOrTx, socialAccountId: string, reason: string) {
  const acc = await tx.socialAccount.findUniqueOrThrow({ where: { id: socialAccountId } });
  if (acc.status === "DISCONNECTED") return;
  await tx.socialAccount.update({
    where: { id: acc.id },
    data: { status: "DISCONNECTED", encryptedAccessToken: null },
  });
  await audit(
    tx,
    systemActor,
    "social_account.disconnected",
    "SocialAccount",
    acc.id,
    { status: acc.status },
    { status: "DISCONNECTED", reason },
  );
  await notify(tx, acc.userId, "ACCOUNT_DISCONNECTED", { handle: acc.handle }, "/clipper/accounts");
}

// ---------------------------------------------------------------------------
// LOCK
// ---------------------------------------------------------------------------

async function fetchForSweep(
  subs: SubWithRefs[],
  adapterFor: (p: Platform) => PlatformAdapter,
): Promise<Map<string, { metrics: MetricResult; existence: PostExistence }>> {
  const out = new Map<string, { metrics: MetricResult; existence: PostExistence }>();
  const byPlatform = new Map<Platform, SubWithRefs[]>();
  for (const s of subs) byPlatform.set(s.platform, [...(byPlatform.get(s.platform) ?? []), s]);
  for (const [platform, list] of byPlatform) {
    const adapter = adapterFor(platform);
    for (const batch of chunk(list, adapter.batchSize)) {
      let results: Map<string, MetricResult>;
      try {
        results = await adapter.fetchPostMetrics(batch.map(postRefFor));
      } catch (e) {
        results = new Map(
          batch.map((s) => [
            s.platformPostId,
            { ok: false, error: "ERROR", message: String(e) } as MetricResult,
          ]),
        );
      }
      for (const sub of batch) {
        const metrics =
          results.get(sub.platformPostId) ??
          ({ ok: false, error: "ERROR", message: "No result" } as MetricResult);
        let existence: PostExistence = metrics.ok ? "LIVE" : "UNKNOWN";
        if (!metrics.ok && (metrics.error === "NOT_FOUND" || metrics.error === "INSIGHTS_UNAVAILABLE")) {
          existence = await adapter.fetchPostExists(postRefFor(sub)).catch(() => "UNKNOWN" as const);
        }
        out.set(sub.id, { metrics, existence });
      }
    }
  }
  return out;
}

/** Metrics we can lock on: live numbers, a missing post, or no insights (falls back to manual snapshots). */
const usableForLock = (m: MetricResult) =>
  m.ok || m.error === "NOT_FOUND" || m.error === "INSIGHTS_UNAVAILABLE";

/** Lock submissions whose tracking window has ended: final views, final accrual, hold. */
export async function lockDueSubmissions(opts: RunOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const polling = await getSetting("polling");
  const adapterFor = adapterFactory(opts, polling, now);
  const due = await db.submission.findMany({
    where: {
      status: "TRACKING",
      trackingEndsAt: { lte: now },
      ...(opts.submissionIds ? { id: { in: opts.submissionIds } } : {}),
    },
    include: { socialAccount: true, campaign: true },
    take: opts.limit ?? 500,
  });
  const fetched = await fetchForSweep(due, adapterFor);
  let locked = 0;
  for (const sub of due) {
    const f = fetched.get(sub.id)!;
    // Transient API errors: retry on the next sweep rather than locking on stale data.
    if (!usableForLock(f.metrics)) continue;
    await db.$transaction(
      async (tx) => {
        const current = await lockSubmission(tx, sub);
        if (current.status !== "TRACKING") return;
        let views: number;
        if (f.metrics.ok) {
          views = (await saveSnapshot(tx, sub.id, SLOT_LOCK, f.metrics, now)).views;
        } else {
          const last = await tx.metricSnapshot.findFirst({
            where: { submissionId: sub.id },
            orderBy: { capturedAt: "desc" },
          });
          views = last?.views ?? 0;
        }
        const capViews = capViewsFor(sub.campaign);
        const lockedViews = capViews !== null ? Math.min(views, capViews) : views;
        await tx.submission.update({
          where: { id: sub.id },
          data: { lockedViews, lockedAt: now, nextSnapshotAt: null },
        });
        await accrue(tx, sub.id, lockedViews, `accrual:${sub.id}:lock`);
        await setStatus(
          tx,
          current,
          "LOCKED",
          systemActor,
          {},
          `Tracking window ended at ${views.toLocaleString("en-IN")} views`,
        );
        await setStatus(tx, { id: sub.id, status: "LOCKED" }, "HELD", systemActor, {
          holdEndsAt: addDays(now, sub.campaign.holdPeriodDays),
        });
        const evaluation = await runFraud(tx, sub.id, "LOCK", now, f.existence);
        await applyFraudDecision(tx, sub.id, evaluation, systemActor, now);
        locked++;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }
  return locked;
}

// ---------------------------------------------------------------------------
// HOLD END -> PAYABLE
// ---------------------------------------------------------------------------

/** Re-check held submissions (post still live? views dropped?) and clear the clean ones. */
export async function processHoldEnds(opts: RunOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const polling = await getSetting("polling");
  const adapterFor = adapterFactory(opts, polling, now);
  const due = await db.submission.findMany({
    where: {
      status: "HELD",
      holdEndsAt: { lte: now },
      reviewState: { not: "NEEDS_REVIEW" },
      ...(opts.submissionIds ? { id: { in: opts.submissionIds } } : {}),
    },
    include: { socialAccount: true, campaign: true },
    take: opts.limit ?? 500,
  });
  const fetched = await fetchForSweep(due, adapterFor);
  let cleared = 0;
  for (const sub of due) {
    const f = fetched.get(sub.id)!;
    if (!usableForLock(f.metrics)) continue;
    const done = await db.$transaction(
      async (tx) => {
        const current = await lockSubmission(tx, sub);
        if (current.status !== "HELD" || current.reviewState === "NEEDS_REVIEW") return false;
        if (f.metrics.ok) await saveSnapshot(tx, sub.id, SLOT_HOLD_END, f.metrics, now);
        const evaluation = await runFraud(tx, sub.id, "HOLD_END", now, f.existence);
        await applyFraudDecision(tx, sub.id, evaluation, systemActor, now);
        const after = await tx.submission.findUniqueOrThrow({ where: { id: sub.id } });
        if (after.status !== "HELD" || after.reviewState === "NEEDS_REVIEW") return false;
        await makePayable(tx, sub.id, systemActor, now);
        return true;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (done) cleared++;
  }
  return cleared;
}

/**
 * Clear a held submission: payable views = min(locked views, hold-end views). A lower count
 * releases the difference back to the budget with an explanation; the rest moves
 * campaign_reserved -> clipper_payable.
 */
export async function makePayable(tx: DbOrTx, submissionId: string, actor: Actor, now: Date) {
  const pre = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { id: true, campaignId: true },
  });
  const sub = await lockSubmission(tx, pre);
  if (sub.status !== "HELD") return;
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: sub.campaignId } });
  const holdSnap = await tx.metricSnapshot.findUnique({
    where: { submissionId_slot: { submissionId: sub.id, slot: SLOT_HOLD_END } },
  });
  const latest = await tx.metricSnapshot.findFirst({
    where: { submissionId: sub.id },
    orderBy: { capturedAt: "desc" },
  });
  const locked = sub.lockedViews ?? latest?.views ?? 0;
  const finalViews = holdSnap ? Math.min(locked, holdSnap.views) : locked;
  const payable = minPaise(sub.earnedPaise, targetEarnings(campaign, finalViews));

  if (payable < sub.earnedPaise) {
    const reduction = sub.earnedPaise - payable;
    await releaseReserved(
      tx,
      sub,
      reduction,
      `holdadjust:${sub.id}`,
      `Payout reduced by ${formatINR(reduction)}: views fell from ${locked.toLocaleString("en-IN")} to ${finalViews.toLocaleString("en-IN")} before payout`,
    );
  }
  if (payable <= 0n) {
    const reason =
      finalViews < campaign.minViewsToQualify
        ? `Did not reach the campaign minimum of ${campaign.minViewsToQualify.toLocaleString("en-IN")} views`
        : "No earnings to pay (campaign budget was already used up)";
    await setStatus(tx, sub, "REJECTED", actor, { finalViews, rejectionReason: reason }, reason);
    await notify(
      tx,
      sub.clipperId,
      "SUBMISSION_REJECTED",
      { campaign: campaign.title, reason },
      `/clipper/submissions/${sub.id}`,
    );
    return;
  }
  await post(tx, {
    idempotencyKey: `clearing:${sub.id}`,
    kind: "CLEARING",
    description: `Cleared earnings for ${finalViews.toLocaleString("en-IN")} views`,
    campaignId: sub.campaignId,
    submissionId: sub.id,
    userId: sub.clipperId,
    entries: [
      debit(acct.campaignReserved(sub.campaignId), payable),
      credit(acct.clipperPayable(sub.clipperId), payable),
    ],
  });
  await setStatus(tx, { id: sub.id, status: "HELD" }, "PAYABLE", actor, { finalViews, payableAt: now });
  await notify(
    tx,
    sub.clipperId,
    "EARNINGS_PAYABLE",
    { amount: formatINR(payable), campaign: campaign.title },
    "/clipper/wallet",
  );
}

/** Everything the worker's lifecycle sweep does, in order. */
export async function runLifecycleSweep(opts: RunOptions = {}) {
  const polled = await pollDueSnapshots(opts);
  const locked = await lockDueSubmissions(opts);
  const cleared = await processHoldEnds(opts);
  return { ...polled, locked, cleared };
}
