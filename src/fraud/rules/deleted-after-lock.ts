import type { FraudRule } from "@/fraud/types";

/** DELETED_OR_PRIVATE_AFTER_LOCK — the post is gone at the lock or hold re-check. Auto-void. */
export const deletedOrPrivateAfterLock: FraudRule = {
  key: "DELETED_OR_PRIVATE_AFTER_LOCK",
  description: "The post was deleted or made private at the lock or hold-end re-check. Auto-void.",
  evaluate(ctx) {
    if (ctx.phase !== "LOCK" && ctx.phase !== "HOLD_END") return null;
    if (ctx.postStatus !== "DELETED" && ctx.postStatus !== "PRIVATE") return null;
    const what = ctx.postStatus === "DELETED" ? "deleted" : "made private";
    return {
      ruleKey: "DELETED_OR_PRIVATE_AFTER_LOCK",
      score: 100,
      action: "VOID",
      explanation: `The post was ${what} before the ${ctx.phase === "LOCK" ? "lock" : "hold-period re-check"}. Earnings are voided.`,
      funderExplanation: `The clipper ${what} the post before payout, so it was not paid.`,
      evidence: { postStatus: ctx.postStatus, phase: ctx.phase },
    };
  },
};
