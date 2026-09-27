import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { acct, balance } from "@/ledger/ledger";
import { verifyLedger } from "@/ledger/verify";
import { accrue } from "@/domain/accrual";
import { joined, makeActiveCampaign, resetDb } from "./factories";

describe("budget reservation under concurrency", () => {
  beforeEach(resetDb);

  it("50 parallel accruals never overspend a nearly-empty campaign", async () => {
    // ₹1,000 budget at ₹30 / 1K views.
    const { campaign } = await makeActiveCampaign({
      budgetPaise: 1_000_00n,
      maxPayoutPerSubmissionPaise: null,
    });
    const clipper = await joined(campaign.id);

    const subs: { id: string }[] = [];
    for (let i = 0; i < 51; i++) {
      subs.push(
        await db.submission.create({
          data: {
            campaignId: campaign.id,
            clipperId: clipper.user.id,
            socialAccountId: clipper.account.id,
            platform: "INSTAGRAM",
            postUrl: `https://www.instagram.com/reel/CONC${i}/`,
            platformPostId: `CONC${i}`,
            status: "TRACKING",
          },
        }),
      );
    }
    // Make it nearly empty: reserve ₹950 first (31,667 views).
    await db.$transaction((tx) => accrue(tx, subs[0]!.id, 31_667, "warmup"));
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(4_999n);

    // 50 clips each wanting ₹300 (10,000 views) — ₹15,000 of demand for ₹49.99 of budget.
    const results = await Promise.allSettled(
      subs
        .slice(1)
        .map((s, i) =>
          db.$transaction((tx) => accrue(tx, s.id, 10_000, `race:${i}`), {
            maxWait: 30_000,
            timeout: 60_000,
          }),
        ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);

    const remaining = await balance(db, acct.campaignBudget(campaign.id));
    const reserved = await balance(db, acct.campaignReserved(campaign.id));
    const earned = await db.submission.aggregate({
      where: { campaignId: campaign.id },
      _sum: { earnedPaise: true },
    });
    expect(remaining).toBe(0n);
    expect(reserved).toBe(1_000_00n);
    expect(earned._sum.earnedPaise).toBe(1_000_00n);
    const granted = results.map((r) => (r.status === "fulfilled" ? r.value.grantedPaise : 0n));
    expect(granted.filter((g) => g > 0n)).toHaveLength(1); // first come, first served
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("EXHAUSTED");
    expect((await verifyLedger()).ok).toBe(true);
  });
});
