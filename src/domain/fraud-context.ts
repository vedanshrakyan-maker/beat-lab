import type { Prisma } from "@prisma/client";
import { evaluateFraud } from "@/fraud/engine";
import type { FraudContext, FraudEvaluation, FraudPhase, SnapshotPoint } from "@/fraud/types";
import { intervals, median } from "@/fraud/util";
import type { DbOrTx } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import type { PostExistence } from "@/platforms/types";
import { parseRules } from "@/domain/campaigns";

/** Loads everything the fraud rules need for one submission. */
export async function buildFraudContext(
  tx: DbOrTx,
  submissionId: string,
  phase: FraudPhase,
  now: Date,
  postStatus: PostExistence | null = null,
): Promise<FraudContext> {
  const sub = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: {
      campaign: true,
      socialAccount: true,
      snapshots: { orderBy: { capturedAt: "asc" } },
    },
  });
  const config = await getSetting("fraud", tx);
  const rules = parseRules(sub.campaign.rules);

  return {
    phase,
    now,
    submission: {
      id: sub.id,
      platform: sub.platform,
      platformPostId: sub.platformPostId,
      caption: sub.caption,
      startedAt: sub.trackingStartedAt ?? sub.submittedAt,
      lockedViews: sub.lockedViews,
      metricsSource: sub.metricsSource,
    },
    snapshots: sub.snapshots.map(toPoint),
    account: {
      handle: sub.socialAccount.handle,
      followerCount: sub.socialAccount.followerCount,
      accountCreatedAt: sub.socialAccount.accountCreatedAt,
    },
    history: {
      medianHourlyGain: await accountMedianHourlyGain(tx, sub.socialAccountId, sub.id),
      duplicateAttempts: await tx.duplicateAttempt.count({ where: { userId: sub.clipperId } }),
    },
    campaign: {
      ratePer1kViewsPaise: sub.campaign.ratePer1kViewsPaise,
      maxPayoutPerSubmissionPaise: sub.campaign.maxPayoutPerSubmissionPaise,
      requiredHashtags: rules.requiredHashtags,
      requiredMentions: rules.requiredMentions,
    },
    postStatus,
    links: await accountLinks(tx, sub.clipperId),
    config,
  };
}

export function toPoint(s: {
  capturedAt: Date;
  views: number;
  reach: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
  source: SnapshotPoint["source"];
}): SnapshotPoint {
  return {
    capturedAt: s.capturedAt,
    views: s.views,
    reach: s.reach,
    likes: s.likes,
    comments: s.comments,
    shares: s.shares,
    saves: s.saves,
    source: s.source,
  };
}

/** Median hourly gain across this account's previous submissions (null if < 5 intervals). */
async function accountMedianHourlyGain(
  tx: DbOrTx,
  socialAccountId: string,
  excludeId: string,
): Promise<number | null> {
  const previous = await tx.submission.findMany({
    where: { socialAccountId, id: { not: excludeId } },
    orderBy: { submittedAt: "desc" },
    take: 20,
    select: { snapshots: { orderBy: { capturedAt: "asc" }, where: { slot: { gte: 0, lt: 1000 } } } },
  });
  const gains = previous.flatMap((p) =>
    intervals(p.snapshots.map(toPoint)).map((i) => Math.max(0, i.hourlyGain)),
  );
  return gains.length >= 5 ? median(gains) : null;
}

/** Other clipper users sharing this user's UPI ID, PAN or device fingerprint. */
export async function accountLinks(tx: DbOrTx, userId: string): Promise<FraudContext["links"]> {
  const profile = await tx.payoutProfile.findUnique({ where: { userId } });
  const sharedUpiUsers = profile
    ? await tx.payoutProfile.count({ where: { upiHash: profile.upiHash, userId: { not: userId } } })
    : 0;
  const sharedPanUsers = profile?.panHash
    ? await tx.payoutProfile.count({ where: { panHash: profile.panHash, userId: { not: userId } } })
    : 0;
  // IP alone is too noisy in India (mobile CGNAT, colleges): require IP + user agent to match.
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT other."userId")::bigint AS n
    FROM "DeviceFingerprint" mine
    JOIN "DeviceFingerprint" other
      ON other."ipHash" = mine."ipHash" AND other."userAgentHash" = mine."userAgentHash" AND other."userId" <> mine."userId"
    WHERE mine."userId" = ${userId}`;
  return { sharedUpiUsers, sharedPanUsers, sharedDeviceUsers: Number(rows[0]?.n ?? 0n) };
}

/** Evaluate and persist signals for one phase (replacing the previous run of that phase). */
export async function runFraud(
  tx: DbOrTx,
  submissionId: string,
  phase: FraudPhase,
  now: Date,
  postStatus: PostExistence | null = null,
): Promise<FraudEvaluation> {
  const ctx = await buildFraudContext(tx, submissionId, phase, now, postStatus);
  const evaluation = evaluateFraud(ctx);
  await tx.fraudSignal.deleteMany({ where: { submissionId, phase } });
  if (evaluation.signals.length > 0) {
    await tx.fraudSignal.createMany({
      data: evaluation.signals.map((s) => ({
        submissionId,
        phase,
        ruleKey: s.ruleKey,
        score: s.score,
        weight: s.weight,
        explanation: s.explanation,
        funderExplanation: s.funderExplanation,
        evidence: s.evidence as Prisma.InputJsonValue,
        createdAt: now,
      })),
    });
  }
  await tx.submission.update({
    where: { id: submissionId },
    data: { fraudScore: evaluation.score, fraudDecision: evaluation.decision },
  });
  return evaluation;
}

/** Derived user risk score: the highest fraud score among their recent submissions. */
export async function refreshUserRisk(tx: DbOrTx, userId: string): Promise<void> {
  const top = await tx.submission.aggregate({
    where: { clipperId: userId, submittedAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    _max: { fraudScore: true },
  });
  await tx.user.update({ where: { id: userId }, data: { riskScore: top._max.fraudScore ?? 0 } });
}
