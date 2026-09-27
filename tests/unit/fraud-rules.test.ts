import { describe, expect, it } from "vitest";
import { deletedOrPrivateAfterLock } from "@/fraud/rules/deleted-after-lock";
import { duplicateSubmission } from "@/fraud/rules/duplicate-submission";
import { lowEngagementRatio } from "@/fraud/rules/low-engagement";
import { multiAccountLink } from "@/fraud/rules/multi-account-link";
import { plateauAtCap } from "@/fraud/rules/plateau-at-cap";
import { captionTokens, missingTags, ruleViolationHints } from "@/fraud/rules/rule-violation-hints";
import { smallAccountOutlier } from "@/fraud/rules/small-account-outlier";
import { velocitySpike } from "@/fraud/rules/velocity-spike";
import { viewDropAfterLock } from "@/fraud/rules/view-drop-after-lock";
import { viewsToReachRatio } from "@/fraud/rules/views-to-reach";
import { ctx, snap } from "./fraud-helpers";

describe("VELOCITY_SPIKE", () => {
  it("flags a vertical jump followed by a flat line", () => {
    const s = velocitySpike.evaluate(
      ctx({ snapshots: [snap(0, 500), snap(1, 900), snap(3, 70_000), snap(24, 70_800), snap(48, 71_000)] }),
    );
    expect(s?.score).toBe(85);
    expect(s?.evidence.pattern).toBe("JUMP_THEN_FLAT");
    expect(s?.explanation).toMatch(/jumped 69,100 in 2h/);
  });

  it("only notes (low score) a fast but organic ramp far above the account median", () => {
    const s = velocitySpike.evaluate(
      ctx({
        history: { medianHourlyGain: 300, duplicateAttempts: 0 },
        snapshots: [snap(0, 1_000), snap(1, 30_000), snap(6, 150_000), snap(24, 400_000), snap(48, 520_000)],
      }),
    );
    expect(s?.score).toBe(20);
    expect(s?.evidence.pattern).toBe("RATIO");
    expect(s?.explanation).toMatch(/× this account's median hourly gain/);
  });

  it("ignores normal growth", () => {
    expect(velocitySpike.evaluate(ctx())).toBeNull();
  });

  it("does not call a jump 'flat' before enough time has passed", () => {
    const s = velocitySpike.evaluate(ctx({ snapshots: [snap(0, 500), snap(1, 900), snap(3, 70_000)] }));
    expect(s?.evidence.pattern).not.toBe("JUMP_THEN_FLAT");
  });
});

describe("LOW_ENGAGEMENT_RATIO", () => {
  it("flags engagement below the floor, severe below a third of it", () => {
    const mild = lowEngagementRatio.evaluate(
      ctx({ snapshots: [snap(24, 100_000, { likes: 200, comments: 10, shares: 10 })] }),
    );
    expect(mild?.score).toBe(50);
    const severe = lowEngagementRatio.evaluate(
      ctx({ snapshots: [snap(24, 100_000, { likes: 50, comments: 0, shares: 0 })] }),
    );
    expect(severe?.score).toBe(90);
    expect(severe?.explanation).toMatch(/0\.05% of 1,00,000 views/);
  });

  it("passes healthy engagement and ignores tiny view counts", () => {
    expect(lowEngagementRatio.evaluate(ctx())).toBeNull();
    expect(
      lowEngagementRatio.evaluate(ctx({ snapshots: [snap(1, 500, { likes: 0, comments: 0, shares: 0 })] })),
    ).toBeNull();
  });

  it("uses the per-platform floor from settings", () => {
    const c = ctx({ snapshots: [snap(24, 100_000, { likes: 200, comments: 0, shares: 0 })] });
    c.config.thresholds.engagementFloorBps.INSTAGRAM = 10; // 0.1%
    expect(lowEngagementRatio.evaluate(c)).toBeNull();
  });
});

describe("VIEWS_TO_REACH_RATIO", () => {
  it("flags looping (many views per unique account)", () => {
    expect(viewsToReachRatio.evaluate(ctx({ snapshots: [snap(24, 60_000, { reach: 15_000 })] }))?.score).toBe(
      70,
    );
    expect(viewsToReachRatio.evaluate(ctx({ snapshots: [snap(24, 60_000, { reach: 10_000 })] }))?.score).toBe(
      90,
    );
  });
  it("skips when reach is unavailable (YouTube) or normal", () => {
    expect(viewsToReachRatio.evaluate(ctx({ snapshots: [snap(24, 60_000, { reach: null })] }))).toBeNull();
    expect(viewsToReachRatio.evaluate(ctx())).toBeNull();
  });
});

describe("SMALL_ACCOUNT_OUTLIER", () => {
  it("fires for a tiny account going big in 24h", () => {
    const s = smallAccountOutlier.evaluate(
      ctx({
        account: { handle: "x", followerCount: 300, accountCreatedAt: null },
        snapshots: [snap(1, 5_000), snap(20, 40_000)],
      }),
    );
    expect(s?.score).toBe(60);
    expect(s?.explanation).toMatch(/300 followers/);
  });
  it("fires for a brand-new account", () => {
    const young = new Date("2026-02-25T00:00:00Z");
    const s = smallAccountOutlier.evaluate(
      ctx({
        account: { handle: "x", followerCount: 900, accountCreatedAt: young },
        snapshots: [snap(20, 60_000)],
      }),
    );
    expect(s?.explanation).toMatch(/created 5 days ago/);
  });
  it("ignores established accounts and views after 24h", () => {
    expect(smallAccountOutlier.evaluate(ctx())).toBeNull();
    expect(
      smallAccountOutlier.evaluate(
        ctx({
          account: { handle: "x", followerCount: 300, accountCreatedAt: null },
          snapshots: [snap(30, 90_000)],
        }),
      ),
    ).toBeNull();
  });
});

describe("PLATEAU_AT_CAP", () => {
  // ₹5,000 cap at ₹30/1K => 1,66,667 views
  it("flags views pinned at the cap view count", () => {
    const s = plateauAtCap.evaluate(
      ctx({
        snapshots: [
          snap(1, 20_000),
          snap(6, 120_000),
          snap(24, 166_000),
          snap(48, 166_900),
          snap(72, 167_100),
        ],
      }),
    );
    expect(s?.score).toBe(85);
    expect(s?.evidence.capViews).toBe(166_667);
  });
  it("does not flag a clip whose natural total happens to saturate near the cap", () => {
    // Organic decay: creeps into the band (~3% growth per day), no jump.
    expect(
      plateauAtCap.evaluate(
        ctx({
          snapshots: [
            snap(1, 20_000),
            snap(24, 140_000),
            snap(48, 158_000),
            snap(72, 163_500),
            snap(96, 165_800),
            snap(120, 166_600),
          ],
        }),
      ),
    ).toBeNull();
  });
  it("does not flag clips that grow through the cap", () => {
    expect(
      plateauAtCap.evaluate(ctx({ snapshots: [snap(1, 20_000), snap(24, 165_000), snap(48, 260_000)] })),
    ).toBeNull();
  });
  it("needs a cap to exist", () => {
    const c = ctx({ snapshots: [snap(1, 1), snap(24, 166_000), snap(48, 166_100)] });
    c.campaign.maxPayoutPerSubmissionPaise = null;
    expect(plateauAtCap.evaluate(c)).toBeNull();
  });
});

describe("DELETED_OR_PRIVATE_AFTER_LOCK", () => {
  it("voids deleted or private posts at hold end", () => {
    const s = deletedOrPrivateAfterLock.evaluate(ctx({ phase: "HOLD_END", postStatus: "DELETED" }));
    expect(s?.action).toBe("VOID");
    expect(
      deletedOrPrivateAfterLock.evaluate(ctx({ phase: "LOCK", postStatus: "PRIVATE" }))?.explanation,
    ).toMatch(/made private/);
  });
  it("ignores live posts and non-lock phases", () => {
    expect(deletedOrPrivateAfterLock.evaluate(ctx({ phase: "HOLD_END", postStatus: "LIVE" }))).toBeNull();
    expect(deletedOrPrivateAfterLock.evaluate(ctx({ phase: "SNAPSHOT", postStatus: "DELETED" }))).toBeNull();
  });
});

describe("VIEW_DROP_AFTER_LOCK", () => {
  const base = ctx({ phase: "HOLD_END" });
  it("flags big drops and notes small ones", () => {
    const big = viewDropAfterLock.evaluate({
      ...base,
      submission: { ...base.submission, lockedViews: 100_000 },
      snapshots: [snap(336, 60_000)],
    });
    expect(big?.score).toBe(80);
    const small = viewDropAfterLock.evaluate({
      ...base,
      submission: { ...base.submission, lockedViews: 100_000 },
      snapshots: [snap(336, 92_000)],
    });
    expect(small?.score).toBe(15);
    const none = viewDropAfterLock.evaluate({
      ...base,
      submission: { ...base.submission, lockedViews: 100_000 },
      snapshots: [snap(336, 101_000)],
    });
    expect(none).toBeNull();
  });
});

describe("DUPLICATE_SUBMISSION", () => {
  it("scales with repeat attempts, capped", () => {
    expect(duplicateSubmission.evaluate(ctx())).toBeNull();
    expect(
      duplicateSubmission.evaluate(ctx({ history: { medianHourlyGain: null, duplicateAttempts: 1 } }))?.score,
    ).toBe(20);
    expect(
      duplicateSubmission.evaluate(ctx({ history: { medianHourlyGain: null, duplicateAttempts: 9 } }))?.score,
    ).toBe(60);
  });
});

describe("MULTI_ACCOUNT_LINK", () => {
  it("is strong for shared UPI/PAN, weaker for a shared device", () => {
    expect(
      multiAccountLink.evaluate(
        ctx({ links: { sharedUpiUsers: 1, sharedPanUsers: 0, sharedDeviceUsers: 0 } }),
      )?.score,
    ).toBe(90);
    expect(
      multiAccountLink.evaluate(
        ctx({ links: { sharedUpiUsers: 0, sharedPanUsers: 0, sharedDeviceUsers: 2 } }),
      )?.score,
    ).toBe(50);
    expect(multiAccountLink.evaluate(ctx())).toBeNull();
  });
});

describe("RULE_VIOLATION_HINTS", () => {
  it("rejects at submission when a required tag is missing", () => {
    const s = ruleViolationHints.evaluate(
      ctx({ phase: "SUBMIT", submission: { ...ctx().submission, caption: "clip #reelpay" } }),
    );
    expect(s?.action).toBe("REJECT");
    expect(s?.explanation).toMatch(/@brandco/);
  });
  it("flags (not rejects) if the caption is edited later", () => {
    const s = ruleViolationHints.evaluate(
      ctx({ phase: "SNAPSHOT", submission: { ...ctx().submission, caption: "no tags" } }),
    );
    expect(s?.action).toBeUndefined();
    expect(s?.score).toBe(100);
  });
  it("matches tags case-insensitively and ignores trailing punctuation", () => {
    expect(missingTags("Watch this! #ReelPay. cc @BrandCo", ["reelpay"], ["brandco"])).toEqual([]);
    expect([...captionTokens("#a #b_c @d.e")]).toEqual(["#a", "#b_c", "@d.e"]);
  });
  it("skips when no caption is available", () => {
    expect(
      ruleViolationHints.evaluate(ctx({ submission: { ...ctx().submission, caption: null } })),
    ).toBeNull();
  });
});
