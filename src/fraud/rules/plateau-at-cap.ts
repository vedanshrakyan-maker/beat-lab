import type { FraudRule } from "@/fraud/types";
import { fmt, pct } from "@/fraud/util";
import { viewsForAmount } from "@/lib/money";

/**
 * PLATEAU_AT_CAP — views stop growing within ±2% of the exact count that earns the
 * per-submission maximum payout (someone bought exactly enough views).
 */
export const plateauAtCap: FraudRule = {
  key: "PLATEAU_AT_CAP",
  description: "Views stall within ±2% of the view count needed for the per-submission maximum payout.",
  evaluate(ctx) {
    const t = ctx.config.thresholds;
    const cap = ctx.campaign.maxPayoutPerSubmissionPaise;
    if (!cap || cap <= 0n || ctx.campaign.ratePer1kViewsPaise <= 0n) return null;
    const capViews = Number(viewsForAmount(cap, ctx.campaign.ratePer1kViewsPaise));
    const snaps = ctx.snapshots;
    const inBand = (v: number) => Math.abs(v - capViews) <= capViews * t.plateauBandPct;
    // First snapshot from which every later snapshot stays in the band around the cap.
    let k = snaps.length;
    while (k > 0 && inBand(snaps[k - 1]!.views)) k--;
    const tail = snaps.slice(k);
    if (tail.length < t.plateauMinSnapshots || k === 0) return null; // need growth history before the plateau
    const first = tail[0]!;
    const last = tail[tail.length - 1]!;
    const growth = first.views > 0 ? (last.views - first.views) / first.views : 0;
    if (growth > t.plateauBandPct) return null;
    // Natural saturation creeps into the band; pushed views jump into it and stop dead.
    const before = snaps[k - 1]!;
    const entryGrowth = before.views > 0 ? (first.views - before.views) / before.views : Infinity;
    if (entryGrowth < t.plateauEntryMinGrowth) return null;
    const hours = (last.capturedAt.getTime() - first.capturedAt.getTime()) / 3_600_000;
    return {
      ruleKey: "PLATEAU_AT_CAP",
      score: 85,
      explanation:
        `Views have sat at ${fmt(last.views)} for ${fmt(hours)}h, within ${pct(t.plateauBandPct, 0)} of ` +
        `${fmt(capViews)} — exactly the views needed for the maximum payout per submission.`,
      funderExplanation: "Views stopped right at the number needed for the maximum payout.",
      evidence: { capViews, views: tail.map((s) => s.views), hours, growth, entryGrowth },
    };
  },
};
