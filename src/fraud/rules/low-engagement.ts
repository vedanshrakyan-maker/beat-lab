import type { FraudRule } from "@/fraud/types";
import { fmt, latest, pct } from "@/fraud/util";

/** LOW_ENGAGEMENT_RATIO — (likes + comments + shares) / views below a per-platform floor. */
export const lowEngagementRatio: FraudRule = {
  key: "LOW_ENGAGEMENT_RATIO",
  description: "(likes + comments + shares) / views below a configurable floor (default 0.3%).",
  evaluate(ctx) {
    const t = ctx.config.thresholds;
    const last = latest(ctx.snapshots);
    if (!last || last.views < t.engagementMinViews) return null;
    const engagements = last.likes + last.comments + last.shares;
    const ratio = engagements / last.views;
    const floor = t.engagementFloorBps[ctx.submission.platform] / 10_000;
    if (ratio >= floor) return null;
    const severe = ratio < floor / 3;
    return {
      ruleKey: "LOW_ENGAGEMENT_RATIO",
      score: severe ? 90 : 50,
      explanation:
        `Only ${pct(ratio, 2)} of ${fmt(last.views)} views liked, commented or shared ` +
        `(${fmt(engagements)} engagements; floor ${pct(floor, 2)}).`,
      funderExplanation: "Very few viewers interacted with the post, which is typical of fake views.",
      evidence: { views: last.views, engagements, ratio, floor },
    };
  },
};
