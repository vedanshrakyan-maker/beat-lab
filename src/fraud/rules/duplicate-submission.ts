import type { FraudRule } from "@/fraud/types";

/**
 * DUPLICATE_SUBMISSION — the unique (platform, platformPostId) constraint blocks the actual
 * duplicate; this rule records a signal against the account for repeat attempts.
 */
export const duplicateSubmission: FraudRule = {
  key: "DUPLICATE_SUBMISSION",
  description: "The clipper has tried to submit posts that were already submitted.",
  evaluate(ctx) {
    const n = ctx.history.duplicateAttempts;
    if (n < 1) return null;
    return {
      ruleKey: "DUPLICATE_SUBMISSION",
      score: Math.min(60, 20 * n),
      explanation: `This clipper has attempted ${n} duplicate submission${n === 1 ? "" : "s"} of posts already in the system.`,
      funderExplanation: "The clipper has tried to submit the same post more than once.",
      evidence: { duplicateAttempts: n },
    };
  },
};
