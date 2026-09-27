import type { FraudRule } from "@/fraud/types";
import { fmt } from "@/fraud/util";

/**
 * SMALL_ACCOUNT_OUTLIER — views ≫ followers within the first 24h on a very new or very small
 * account. Genuine viral clips happen, so this has a low default weight and is meant to
 * combine with other signals rather than act alone.
 */
export const smallAccountOutlier: FraudRule = {
  key: "SMALL_ACCOUNT_OUTLIER",
  description: "Views far above follower count within the first hours on a very new or very small account.",
  evaluate(ctx) {
    const t = ctx.config.thresholds;
    const { followerCount, accountCreatedAt } = ctx.account;
    const ageDays = accountCreatedAt ? (ctx.now.getTime() - accountCreatedAt.getTime()) / 86_400_000 : null;
    const small = followerCount < t.smallAccountFollowers;
    // A negative age means bad data (account "created" after the post): ignore rather than guess.
    const young = ageDays !== null && ageDays >= 0 && ageDays < t.smallAccountAgeDays;
    if (!small && !young) return null;

    const cutoff = ctx.submission.startedAt.getTime() + 24 * 3_600_000;
    const early = ctx.snapshots.filter((s) => s.capturedAt.getTime() <= cutoff);
    const views = early.reduce((m, s) => Math.max(m, s.views), 0);
    const perFollower = views / Math.max(1, followerCount);
    if (views < t.smallAccountMinViews || perFollower < t.smallAccountViewsPerFollower) return null;
    const who = [
      small ? `${fmt(followerCount)} followers` : null,
      young ? `created ${fmt(ageDays!)} days ago` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ruleKey: "SMALL_ACCOUNT_OUTLIER",
      score: 60,
      explanation:
        `Reached ${fmt(views)} views within 24h on an account with ${who} (${fmt(perFollower)}× followers). ` +
        `Genuine viral clips happen; weighted low and combined with other signals.`,
      funderExplanation: "A very small or new account got unusually many views quickly.",
      evidence: { views, followerCount, ageDays, perFollower },
    };
  },
};
