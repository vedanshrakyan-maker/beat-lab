import { fraudRules } from "@/fraud/rules";
import type { FraudContext, FraudDecision, FraudEvaluation, FraudRule, WeightedSignal } from "@/fraud/types";

/**
 * Runs every enabled rule, weights the signals and maps the combined score to a decision.
 *
 *   combined = min(100, round(Σ score_i × weight_i))
 *   combined < reviewAt           -> AUTO_APPROVE
 *   reviewAt <= combined < flagAt -> MANUAL_REVIEW
 *   combined >= flagAt            -> AUTO_FLAG (earnings frozen until an admin decides)
 *
 * Hard actions override the score: a VOID signal -> AUTO_VOID, a REJECT signal -> AUTO_REJECT.
 * Manual (screen-recording) metrics use stricter bands (both thresholds lowered).
 */
export function evaluateFraud(ctx: FraudContext, rules: FraudRule[] = fraudRules): FraudEvaluation {
  const signals: WeightedSignal[] = [];
  for (const rule of rules) {
    const toggle = ctx.config.rules[rule.key];
    if (toggle && !toggle.enabled) continue;
    const result = rule.evaluate(ctx);
    if (result) signals.push({ ...result, weight: toggle?.weight ?? 1 });
  }
  const score = combineScore(signals);
  return { phase: ctx.phase, score, decision: decide(score, signals, ctx), signals };
}

export function combineScore(signals: Pick<WeightedSignal, "score" | "weight">[]): number {
  const raw = signals.reduce((sum, s) => sum + s.score * s.weight, 0);
  return Math.min(100, Math.round(raw));
}

export function bandsFor(ctx: Pick<FraudContext, "config" | "submission">): {
  reviewAt: number;
  flagAt: number;
} {
  const { reviewAt, flagAt, manualStrictnessOffset } = ctx.config.bands;
  if (ctx.submission.metricsSource !== "MANUAL") return { reviewAt, flagAt };
  return {
    reviewAt: Math.max(1, reviewAt - manualStrictnessOffset),
    flagAt: Math.max(1, flagAt - manualStrictnessOffset),
  };
}

function decide(score: number, signals: WeightedSignal[], ctx: FraudContext): FraudDecision {
  if (signals.some((s) => s.action === "VOID")) return "AUTO_VOID";
  if (signals.some((s) => s.action === "REJECT")) return "AUTO_REJECT";
  const { reviewAt, flagAt } = bandsFor(ctx);
  if (score >= flagAt) return "AUTO_FLAG";
  if (score >= reviewAt) return "MANUAL_REVIEW";
  return "AUTO_APPROVE";
}
