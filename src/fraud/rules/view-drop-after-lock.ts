import type { FraudRule } from "@/fraud/types";
import { fmt, latest, pct } from "@/fraud/util";

/**
 * VIEW_DROP_AFTER_LOCK — views fell between lock and hold end (platforms remove fake views).
 * Small drops only reduce the payout (and explain why); big drops flag the submission.
 */
export const viewDropAfterLock: FraudRule = {
  key: "VIEW_DROP_AFTER_LOCK",
  description: "Views fell by more than X% between lock and hold end (the platform removed fake views).",
  evaluate(ctx) {
    if (ctx.phase !== "HOLD_END") return null;
    const t = ctx.config.thresholds;
    const locked = ctx.submission.lockedViews;
    const last = latest(ctx.snapshots);
    if (!locked || locked <= 0 || !last) return null;
    const drop = (locked - last.views) / locked;
    if (drop < t.viewDropNoticePct) return null;
    const severe = drop >= t.viewDropFlagPct;
    return {
      ruleKey: "VIEW_DROP_AFTER_LOCK",
      score: severe ? 80 : 15,
      explanation:
        `Views fell from ${fmt(locked)} at lock to ${fmt(last.views)} at the hold re-check (−${pct(drop)}). ` +
        (severe ? "The platform likely removed fake views." : "The payout is reduced to the lower count."),
      funderExplanation: severe
        ? "The platform removed a large share of this post's views after it was locked."
        : "Views dipped slightly after lock; payout uses the lower count.",
      evidence: { lockedViews: locked, holdEndViews: last.views, drop },
    };
  },
};
