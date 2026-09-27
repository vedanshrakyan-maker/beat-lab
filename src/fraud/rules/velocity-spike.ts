import type { FraudRule } from "@/fraud/types";
import { fmt, intervals, latest, pct } from "@/fraud/util";

/**
 * VELOCITY_SPIKE — (A) a vertical jump followed by a flat line (the bought-views pattern),
 * or (B) an hourly gain far above this account's historical median.
 * (B) alone is informational (genuine viral clips spike too); (A) is strong.
 */
export const velocitySpike: FraudRule = {
  key: "VELOCITY_SPIKE",
  description: "Hourly view gain far above the account's median, or a vertical jump followed by a flat line.",
  evaluate(ctx) {
    const t = ctx.config.thresholds;
    const ivs = intervals(ctx.snapshots);
    const last = latest(ctx.snapshots);
    if (ivs.length === 0 || !last || last.views <= 0) return null;

    // (A) jump then flat
    const biggest = ivs.reduce((a, b) => (b.gain > a.gain ? b : a));
    const share = biggest.gain / last.views;
    if (
      share >= t.jumpShareOfTotal &&
      biggest.hours <= t.jumpMaxIntervalHours &&
      biggest.hourlyGain >= t.velocityMinAbsoluteHourlyGain
    ) {
      const after = last.views - biggest.to.views;
      const hoursAfter = (last.capturedAt.getTime() - biggest.to.capturedAt.getTime()) / 3_600_000;
      const growthAfter = biggest.to.views > 0 ? after / biggest.to.views : 0;
      if (hoursAfter >= t.flatAfterJumpMinHours && growthAfter <= t.flatAfterJumpMaxGrowth) {
        return {
          ruleKey: "VELOCITY_SPIKE",
          score: 85,
          explanation:
            `Views jumped ${fmt(biggest.gain)} in ${fmt(biggest.hours)}h (${pct(share, 0)} of all views), ` +
            `then grew only ${pct(growthAfter)} over the next ${fmt(hoursAfter)}h — the pattern of purchased views.`,
          funderExplanation:
            "Views arrived in one sudden block and then stopped, which matches bought views.",
          evidence: {
            pattern: "JUMP_THEN_FLAT",
            jumpGain: biggest.gain,
            jumpHours: biggest.hours,
            shareOfTotal: share,
            growthAfter,
            hoursAfter,
          },
        };
      }
    }

    // (B) ratio vs. the account's historical median hourly gain
    const fastest = ivs.reduce((a, b) => (b.hourlyGain > a.hourlyGain ? b : a));
    const baseline = Math.max(ctx.history.medianHourlyGain ?? 0, t.velocityBaselineHourlyGain);
    const ratio = fastest.hourlyGain / baseline;
    if (fastest.hourlyGain >= t.velocityMinAbsoluteHourlyGain && ratio >= t.velocitySpikeMultiplier) {
      return {
        ruleKey: "VELOCITY_SPIKE",
        score: 20,
        explanation:
          `Views grew ${fmt(fastest.hourlyGain)}/hour over ${fmt(fastest.hours)}h, ` +
          `${fmt(ratio)}× this account's median hourly gain (${fmt(baseline)}/hour). Informational on its own.`,
        funderExplanation: "Views grew much faster than this account usually does.",
        evidence: { pattern: "RATIO", hourlyGain: fastest.hourlyGain, baseline, ratio },
      };
    }
    return null;
  },
};
