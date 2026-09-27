import type { FraudRule } from "@/fraud/types";
import { deletedOrPrivateAfterLock } from "@/fraud/rules/deleted-after-lock";
import { duplicateSubmission } from "@/fraud/rules/duplicate-submission";
import { lowEngagementRatio } from "@/fraud/rules/low-engagement";
import { multiAccountLink } from "@/fraud/rules/multi-account-link";
import { plateauAtCap } from "@/fraud/rules/plateau-at-cap";
import { ruleViolationHints } from "@/fraud/rules/rule-violation-hints";
import { smallAccountOutlier } from "@/fraud/rules/small-account-outlier";
import { velocitySpike } from "@/fraud/rules/velocity-spike";
import { viewDropAfterLock } from "@/fraud/rules/view-drop-after-lock";
import { viewsToReachRatio } from "@/fraud/rules/views-to-reach";

/** The rule registry. To add a rule: write a pure FraudRule, add it here and to fraudRuleKeys. */
export const fraudRules: FraudRule[] = [
  velocitySpike,
  lowEngagementRatio,
  viewsToReachRatio,
  smallAccountOutlier,
  plateauAtCap,
  deletedOrPrivateAfterLock,
  viewDropAfterLock,
  duplicateSubmission,
  multiAccountLink,
  ruleViolationHints,
];
