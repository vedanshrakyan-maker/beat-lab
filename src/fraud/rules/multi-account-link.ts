import type { FraudRule } from "@/fraud/types";

/** MULTI_ACCOUNT_LINK — the same UPI ID, PAN, or device/IP fingerprint across clipper users. */
export const multiAccountLink: FraudRule = {
  key: "MULTI_ACCOUNT_LINK",
  description: "Same UPI ID, PAN, or device/IP fingerprint shared across multiple clipper users.",
  evaluate(ctx) {
    const { sharedUpiUsers, sharedPanUsers, sharedDeviceUsers } = ctx.links;
    if (sharedUpiUsers + sharedPanUsers + sharedDeviceUsers === 0) return null;
    const parts: string[] = [];
    if (sharedUpiUsers)
      parts.push(`UPI ID shared with ${sharedUpiUsers} other clipper${sharedUpiUsers > 1 ? "s" : ""}`);
    if (sharedPanUsers)
      parts.push(`PAN shared with ${sharedPanUsers} other clipper${sharedPanUsers > 1 ? "s" : ""}`);
    if (sharedDeviceUsers)
      parts.push(
        `device/IP fingerprint shared with ${sharedDeviceUsers} other clipper${sharedDeviceUsers > 1 ? "s" : ""}`,
      );
    const strong = sharedUpiUsers > 0 || sharedPanUsers > 0;
    return {
      ruleKey: "MULTI_ACCOUNT_LINK",
      score: strong ? 90 : 50,
      explanation: `Linked accounts: ${parts.join("; ")}.`,
      funderExplanation: "This clipper appears to operate several accounts on our platform.",
      evidence: { sharedUpiUsers, sharedPanUsers, sharedDeviceUsers },
    };
  },
};
