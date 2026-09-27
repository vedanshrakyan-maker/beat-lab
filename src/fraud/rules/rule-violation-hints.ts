import type { FraudRule } from "@/fraud/types";

function normalizeTag(tag: string, prefix: "#" | "@"): string {
  const t = tag.trim().toLowerCase();
  return t.startsWith(prefix) ? t : `${prefix}${t}`;
}

/** Tags present in a caption, lower-cased (#tag and @mention tokens). */
export function captionTokens(caption: string): Set<string> {
  return new Set(
    (caption.toLowerCase().match(/[#@][\p{L}\p{N}_.]+/gu) ?? []).map((t) => t.replace(/\.+$/, "")),
  );
}

export function missingTags(caption: string, hashtags: string[], mentions: string[]): string[] {
  const tokens = captionTokens(caption);
  const required = [
    ...hashtags.map((h) => normalizeTag(h, "#")),
    ...mentions.map((m) => normalizeTag(m, "@")),
  ];
  return required.filter((tag) => !tokens.has(tag));
}

/**
 * RULE_VIOLATION_HINTS — required hashtag or mention missing from the caption (from the
 * API caption/snippet). Rejection-worthy on its own at submission time.
 */
export const ruleViolationHints: FraudRule = {
  key: "RULE_VIOLATION_HINTS",
  description: "Missing required hashtag or mention in the caption. Rejection-worthy on its own.",
  evaluate(ctx) {
    const { caption } = ctx.submission;
    const { requiredHashtags, requiredMentions } = ctx.campaign;
    if (caption === null || requiredHashtags.length + requiredMentions.length === 0) return null;
    const missing = missingTags(caption, requiredHashtags, requiredMentions);
    if (missing.length === 0) return null;
    return {
      ruleKey: "RULE_VIOLATION_HINTS",
      score: 100,
      action: ctx.phase === "SUBMIT" ? "REJECT" : undefined,
      explanation: `The caption is missing required ${missing.join(", ")}.`,
      funderExplanation: `The post did not include the required ${missing.join(", ")}.`,
      evidence: { missing, requiredHashtags, requiredMentions },
    };
  },
};
