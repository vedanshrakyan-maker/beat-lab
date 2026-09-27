import { describe, expect, it } from "vitest";
import { combineScore, evaluateFraud } from "@/fraud/engine";
import { simulateAll } from "@/fraud/simulate";
import { ctx, snap } from "./fraud-helpers";

describe("fraud engine", () => {
  it("auto-approves clean submissions", () => {
    const r = evaluateFraud(ctx());
    expect(r.score).toBe(0);
    expect(r.decision).toBe("AUTO_APPROVE");
  });

  it("combines weighted scores and caps at 100", () => {
    expect(combineScore([{ score: 60, weight: 0.4 }])).toBe(24);
    expect(
      combineScore([
        { score: 90, weight: 1 },
        { score: 90, weight: 0.8 },
      ]),
    ).toBe(100);
  });

  it("maps scores to decision bands", () => {
    // Low engagement 50 × 0.8 = 40 -> review
    expect(
      evaluateFraud(ctx({ snapshots: [snap(24, 100_000, { likes: 200, comments: 5, shares: 5 })] })).decision,
    ).toBe("MANUAL_REVIEW");
    // Shared UPI 90 -> flag
    expect(
      evaluateFraud(ctx({ links: { sharedUpiUsers: 1, sharedPanUsers: 0, sharedDeviceUsers: 0 } })).decision,
    ).toBe("AUTO_FLAG");
  });

  it("hard actions override the score", () => {
    expect(evaluateFraud(ctx({ phase: "HOLD_END", postStatus: "DELETED" })).decision).toBe("AUTO_VOID");
    expect(
      evaluateFraud(ctx({ phase: "SUBMIT", submission: { ...ctx().submission, caption: "nothing" } }))
        .decision,
    ).toBe("AUTO_REJECT");
  });

  it("respects enabled flags and weights from settings", () => {
    const c = ctx({ links: { sharedUpiUsers: 1, sharedPanUsers: 0, sharedDeviceUsers: 0 } });
    c.config.rules.MULTI_ACCOUNT_LINK = { enabled: false, weight: 1 };
    expect(evaluateFraud(c).decision).toBe("AUTO_APPROVE");
    c.config.rules.MULTI_ACCOUNT_LINK = { enabled: true, weight: 0.5 };
    expect(evaluateFraud(c).score).toBe(45);
  });

  it("applies stricter bands to manual metrics", () => {
    const c = ctx({ links: { sharedUpiUsers: 0, sharedPanUsers: 0, sharedDeviceUsers: 1 } }); // 50
    expect(evaluateFraud(c).decision).toBe("MANUAL_REVIEW");
    c.submission.metricsSource = "MANUAL"; // bands 20 / 60
    expect(evaluateFraud(c).decision).toBe("MANUAL_REVIEW");
    c.links.sharedDeviceUsers = 0;
    c.snapshots = [snap(24, 100_000, { likes: 200, comments: 5, shares: 5 })]; // 40
    expect(evaluateFraud(c).decision).toBe("MANUAL_REVIEW");
    c.snapshots = [snap(24, 100_000, { likes: 50, comments: 0, shares: 0 })]; // 72
    expect(evaluateFraud(c).decision).toBe("AUTO_FLAG");
  });

  it("every explanation is plain English with numbers", () => {
    const r = evaluateFraud(
      ctx({ snapshots: [snap(0, 500), snap(1, 900), snap(3, 70_000), snap(24, 70_800)] }),
    );
    for (const s of r.signals) {
      expect(s.explanation.length).toBeGreaterThan(20);
      expect(s.funderExplanation.length).toBeGreaterThan(10);
    }
  });
});

describe("fraud simulation acceptance (npm run fraud:simulate)", () => {
  it("auto-approves every clean scenario and flags/voids/rejects every fraud scenario", async () => {
    const results = await simulateAll(5);
    const failures = results.filter((r) => !r.passed).map((r) => `${r.scenario}: ${r.finalDecision}`);
    expect(failures).toEqual([]);
  });
});
