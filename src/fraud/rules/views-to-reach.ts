import type { FraudRule } from "@/fraud/types";
import { fmt, latest } from "@/fraud/util";

/** VIEWS_TO_REACH_RATIO — views per unique account far above normal suggests looping or bots. */
export const viewsToReachRatio: FraudRule = {
  key: "VIEWS_TO_REACH_RATIO",
  description:
    "When reach is available, views/reach above a threshold (default 3.0) suggests looping or bots.",
  evaluate(ctx) {
    const t = ctx.config.thresholds;
    const last = latest(ctx.snapshots);
    if (!last || last.reach === null || last.reach <= 0 || last.views < t.reachMinViews) return null;
    const ratio = last.views / last.reach;
    if (ratio <= t.viewsToReachMax) return null;
    return {
      ruleKey: "VIEWS_TO_REACH_RATIO",
      score: ratio > t.viewsToReachMax * (5 / 3) ? 90 : 70,
      explanation:
        `${fmt(last.views)} views came from only ${fmt(last.reach)} unique accounts ` +
        `(${ratio.toFixed(1)} views per account; threshold ${t.viewsToReachMax.toFixed(1)}).`,
      funderExplanation: "The same few accounts watched the post over and over.",
      evidence: { views: last.views, reach: last.reach, ratio, threshold: t.viewsToReachMax },
    };
  },
};
