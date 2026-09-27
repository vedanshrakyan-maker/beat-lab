import type { Campaign } from "@prisma/client";
import { db } from "@/lib/db";
import { toDecimalRupees, type Paise } from "@/lib/money";
import { targetEarnings } from "@/domain/accrual";
import { campaignMoney } from "@/domain/campaigns";
import { toCsv } from "@/domain/tax";

const BLOCKED = ["VOIDED", "REJECTED", "CLAWED_BACK"] as const;

export interface CampaignAnalytics {
  verifiedViews: number;
  spendPaise: Paise;
  remainingPaise: Paise;
  reservedPaise: Paise;
  clearedPaise: Paise;
  effectiveCpmPaise: Paise | null;
  clippers: number;
  submissions: number;
  byStatus: Record<string, number>;
  fraud: {
    blockedSubmissions: number;
    blockedViews: number;
    savedPaise: Paise;
    underReview: number;
    reasons: { ruleKey: string; count: number; example: string }[];
  };
  top: {
    id: string;
    handle: string;
    platform: string;
    views: number;
    earnedPaise: Paise;
    status: string;
    postUrl: string;
  }[];
  daily: { t: Date; v: number }[];
}

/** Funder dashboard numbers. "Verified views" are views on submissions that passed (or are passing) fraud checks. */
export async function campaignAnalytics(campaign: Campaign): Promise<CampaignAnalytics> {
  const subs = await db.submission.findMany({
    where: { campaignId: campaign.id },
    include: {
      socialAccount: { select: { handle: true } },
      snapshots: { orderBy: { capturedAt: "asc" }, select: { capturedAt: true, views: true } },
      fraudSignals: { where: { score: { gte: 50 } }, select: { ruleKey: true, funderExplanation: true } },
    },
  });
  const money = await campaignMoney(db, campaign);
  const viewsOf = (s: (typeof subs)[number]) =>
    s.finalViews ?? s.lockedViews ?? s.snapshots[s.snapshots.length - 1]?.views ?? 0;

  let verifiedViews = 0;
  let blockedViews = 0;
  let savedPaise = 0n;
  const byStatus: Record<string, number> = {};
  const reasonMap = new Map<string, { count: number; example: string }>();
  for (const s of subs) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const v = viewsOf(s);
    if ((BLOCKED as readonly string[]).includes(s.status)) {
      blockedViews += v;
      savedPaise += targetEarnings(campaign, v);
      for (const f of s.fraudSignals) {
        const r = reasonMap.get(f.ruleKey) ?? { count: 0, example: f.funderExplanation };
        r.count++;
        reasonMap.set(f.ruleKey, r);
      }
    } else if (s.status !== "SUBMITTED" && s.status !== "UNDER_REVIEW" && s.status !== "FLAGGED") {
      verifiedViews += v;
    }
  }

  // Daily verified-view totals: for each day, sum each submission's latest snapshot up to that day.
  const days = new Map<number, number>();
  const verifiedSubs = subs.filter(
    (s) => !(BLOCKED as readonly string[]).includes(s.status) && s.snapshots.length,
  );
  const allTimes = verifiedSubs.flatMap((s) => s.snapshots.map((p) => p.capturedAt.getTime()));
  if (allTimes.length) {
    const start = Math.floor(Math.min(...allTimes) / 86_400_000);
    const end = Math.floor(Math.max(...allTimes) / 86_400_000);
    for (let d = start; d <= end; d++) {
      const cutoff = (d + 1) * 86_400_000;
      let total = 0;
      for (const s of verifiedSubs) {
        let last = 0;
        for (const p of s.snapshots) if (p.capturedAt.getTime() < cutoff) last = p.views;
        total += last;
      }
      days.set(d, total);
    }
  }

  const spend = money.spentPaise;
  return {
    verifiedViews,
    spendPaise: spend,
    remainingPaise: money.remainingPaise,
    reservedPaise: money.reservedPaise,
    clearedPaise: money.clearedPaise,
    effectiveCpmPaise: verifiedViews > 0 ? (spend * 1000n) / BigInt(verifiedViews) : null,
    clippers: new Set(subs.map((s) => s.clipperId)).size,
    submissions: subs.length,
    byStatus,
    fraud: {
      blockedSubmissions: subs.filter((s) => (BLOCKED as readonly string[]).includes(s.status)).length,
      blockedViews,
      savedPaise,
      underReview: subs.filter((s) => s.status === "FLAGGED" || s.reviewState === "NEEDS_REVIEW").length,
      reasons: [...reasonMap].map(([ruleKey, r]) => ({ ruleKey, ...r })).sort((a, b) => b.count - a.count),
    },
    top: subs
      .filter((s) => !(BLOCKED as readonly string[]).includes(s.status))
      .map((s) => ({
        id: s.id,
        handle: s.socialAccount.handle,
        platform: s.platform,
        views: viewsOf(s),
        earnedPaise: s.earnedPaise,
        status: s.status,
        postUrl: s.postUrl,
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
    daily: [...days].map(([d, v]) => ({ t: new Date(d * 86_400_000), v })),
  };
}

/** Results report CSV for funders (PDF later). */
export async function campaignResultsCsv(campaign: Campaign): Promise<string> {
  const subs = await db.submission.findMany({
    where: { campaignId: campaign.id },
    orderBy: { submittedAt: "asc" },
    include: {
      socialAccount: { select: { handle: true, followerCount: true } },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      fraudSignals: { where: { score: { gte: 50 } }, select: { funderExplanation: true } },
    },
  });
  const rows: (string | number)[][] = [
    [
      "submission_id",
      "submitted_at",
      "platform",
      "handle",
      "followers",
      "post_url",
      "status",
      "latest_views",
      "locked_views",
      "final_views",
      "earned_inr",
      "fraud_score",
      "fraud_reasons",
    ],
  ];
  for (const s of subs) {
    rows.push([
      s.id,
      s.submittedAt.toISOString(),
      s.platform,
      s.socialAccount.handle,
      s.socialAccount.followerCount,
      s.postUrl,
      s.status,
      s.snapshots[0]?.views ?? 0,
      s.lockedViews ?? "",
      s.finalViews ?? "",
      toDecimalRupees(s.earnedPaise),
      s.fraudScore,
      [...new Set(s.fraudSignals.map((f) => f.funderExplanation))].join(" | ") || s.rejectionReason || "",
    ]);
  }
  return toCsv(rows);
}
