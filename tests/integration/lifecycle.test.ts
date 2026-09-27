import { beforeEach, describe, expect, it } from "vitest";
import { userActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { acct, balance } from "@/ledger/ledger";
import { verifyLedger } from "@/ledger/verify";
import { catchUpSubmission } from "@/domain/devtools";
import { pollDueSnapshots } from "@/domain/lifecycle";
import {
  approvePayoutBatch,
  createPayoutBatch,
  PayoutError,
  requestWithdrawal,
  savePayoutProfile,
  syncProcessingPayouts,
  walletSummary,
} from "@/domain/payouts";
import { adminVoidSubmission, approveSubmission, enterManualMetrics } from "@/domain/review";
import { SubmissionError, submitPost } from "@/domain/submissions";
import { daysAgo, joined, makeActiveCampaign, makeUser, mockProvider, reelUrl, resetDb } from "./factories";

async function submitAt(
  clipper: Awaited<ReturnType<typeof joined>>,
  campaignId: string,
  url: string,
  when: Date,
) {
  return submitPost(
    clipper.user.id,
    { campaignId, socialAccountId: clipper.account.id, postUrl: url },
    userActor(clipper.user.id),
    { now: when },
  );
}

async function expectPayable(id: string) {
  const s = await db.submission.findUniqueOrThrow({ where: { id }, include: { fraudSignals: true } });
  expect({
    status: s.status,
    signals: s.fraudSignals.map((f) => `${f.phase}:${f.ruleKey}:${f.score}`),
  }).toMatchObject({ status: "PAYABLE" });
}

async function ledgerOk() {
  const r = await verifyLedger();
  expect(r.checks.filter((c) => !c.ok)).toEqual([]);
}

describe("submission lifecycle (mock platforms)", () => {
  beforeEach(resetDb);

  it("clean post: tracking -> locked -> held -> payable -> withdrawn -> paid, with TDS", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id);
    const res = await submitAt(clipper, campaign.id, reelUrl("clean_viral"), daysAgo(20));
    expect(res.outcome).toBe("TRACKING");
    expect(res.checks.find((c) => c.label.startsWith("Required"))?.ok).toBe(true);

    await catchUpSubmission(res.submission.id);
    const sub = await db.submission.findUniqueOrThrow({
      where: { id: res.submission.id },
      include: { snapshots: true },
    });
    expect(sub.status).toBe("PAYABLE");
    expect(sub.snapshots.length).toBeGreaterThanOrEqual(10); // T+0,1h,6h,24h, daily, lock, hold end
    expect(sub.lockedViews).toBe(Math.min(sub.lockedViews!, 666_667)); // ₹20,000 cap at ₹30/1K
    expect(sub.earnedPaise).toBeGreaterThan(0n);
    expect(await balance(db, acct.clipperPayable(clipper.user.id))).toBe(sub.earnedPaise);
    expect(await balance(db, acct.campaignReserved(campaign.id))).toBe(0n);

    // Idempotent: re-running the sweeps changes nothing.
    await pollDueSnapshots();
    await catchUpSubmission(res.submission.id);
    expect(await db.ledgerTransaction.count({ where: { submissionId: sub.id, kind: "CLEARING" } })).toBe(1);

    await savePayoutProfile(
      clipper.user.id,
      { legalName: "Asha Verma", upiId: "asha@okaxis", pan: "ABCDE1234F" },
      userActor(clipper.user.id),
    );
    const payout = await requestWithdrawal(clipper.user.id, "req-000001", userActor(clipper.user.id));
    expect(await requestWithdrawal(clipper.user.id, "req-000001", userActor(clipper.user.id))).toMatchObject({
      id: payout.id,
    });
    expect(payout.grossPaise).toBe(sub.earnedPaise);
    expect(payout.tdsPaise + payout.netPaise).toBe(payout.grossPaise);
    if (payout.grossPaise > 30_000_00n) expect(payout.tdsPaise).toBe(payout.grossPaise / 10n);

    const admin = await makeUser(["ADMIN"], "Admin");
    const batch = await createPayoutBatch(admin.id, userActor(admin.id));
    await approvePayoutBatch(batch.id, admin.id, userActor(admin.id), mockProvider());
    expect((await db.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("PROCESSING");
    await syncProcessingPayouts(mockProvider());

    const paid = await db.payout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(paid.status).toBe("PAID");
    expect((await db.submission.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("PAID");
    expect((await db.payoutBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("COMPLETED");
    expect(await balance(db, acct.tdsPayable())).toBe(paid.tdsPaise);
    const wallet = await walletSummary(clipper.user.id);
    expect(wallet.payablePaise).toBe(0n);
    expect(wallet.paidOutNetPaise).toBe(paid.netPaise);
    await ledgerOk();
  });

  it("voids a post deleted after lock and returns the money to the budget", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id);
    const res = await submitAt(clipper, campaign.id, reelUrl("deleted_after_lock"), daysAgo(20));
    await catchUpSubmission(res.submission.id);
    const sub = await db.submission.findUniqueOrThrow({
      where: { id: res.submission.id },
      include: { fraudSignals: true },
    });
    expect(sub.status).toBe("VOIDED");
    expect(sub.earnedPaise).toBe(0n);
    expect(sub.fraudSignals.map((s) => s.ruleKey)).toContain("DELETED_OR_PRIVATE_AFTER_LOCK");
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(campaign.budgetPaise);
    await ledgerOk();
  });

  it("flags a botted spike, freezes earnings, and an admin void releases them", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id, "INSTAGRAM", 1_200);
    const res = await submitAt(clipper, campaign.id, reelUrl("botted_spike"), daysAgo(20));
    await catchUpSubmission(res.submission.id);
    const flagged = await db.submission.findUniqueOrThrow({ where: { id: res.submission.id } });
    expect(flagged.status).toBe("FLAGGED");
    expect(flagged.fraudScore).toBeGreaterThanOrEqual(70);
    const frozen = flagged.earnedPaise;

    const admin = await makeUser(["ADMIN"], "Admin");
    await adminVoidSubmission(flagged.id, admin.id, "Bought views: jump then flat line", userActor(admin.id));
    const voided = await db.submission.findUniqueOrThrow({ where: { id: flagged.id } });
    expect(voided.status).toBe("VOIDED");
    expect(await balance(db, acct.campaignReserved(campaign.id))).toBe(0n);
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(campaign.budgetPaise);
    expect(frozen).toBeGreaterThanOrEqual(0n);
    expect(await db.reviewDecision.count({ where: { submissionId: flagged.id, decision: "VOID" } })).toBe(1);
    await ledgerOk();
  });

  it("rejects a post missing the required hashtag at submission", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id);
    const res = await submitAt(clipper, campaign.id, reelUrl("missing_hashtag"), new Date());
    expect(res.outcome).toBe("REJECTED");
    expect(res.submission.rejectionReason).toMatch(/#reelpay/);
  });

  it("blocks duplicate submissions system-wide and records the attempt", async () => {
    const { campaign } = await makeActiveCampaign();
    const a = await joined(campaign.id);
    const b = await joined(campaign.id);
    const url = reelUrl();
    await submitAt(a, campaign.id, url, new Date());
    await expect(submitAt(b, campaign.id, url, new Date())).rejects.toThrow(SubmissionError);
    expect(await db.duplicateAttempt.count({ where: { userId: b.user.id } })).toBe(1);
  });

  it("routes unavailable insights to manual verification, then pays from admin-entered metrics", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id, "INSTAGRAM", 600);
    const res = await submitAt(clipper, campaign.id, reelUrl("insights_unavailable"), daysAgo(20));
    expect(res.outcome).toBe("UNDER_REVIEW");
    expect(res.submission.metricsSource).toBe("UNAVAILABLE");

    const admin = await makeUser(["ADMIN"], "Admin");
    await enterManualMetrics(
      res.submission.id,
      admin.id,
      { views: 12_000, likes: 900, comments: 40, shares: 60, capturedAt: daysAgo(12) },
      userActor(admin.id),
      daysAgo(12),
    );
    await approveSubmission(
      res.submission.id,
      admin.id,
      "Screen recording matches the entered numbers",
      userActor(admin.id),
      daysAgo(12),
    );
    await catchUpSubmission(res.submission.id);
    const sub = await db.submission.findUniqueOrThrow({
      where: { id: res.submission.id },
      include: { snapshots: true },
    });
    expect(sub.metricsSource).toBe("MANUAL");
    expect(sub.snapshots.find((s) => s.source === "MANUAL")?.enteredById).toBe(admin.id);
    expect(sub.status).toBe("PAYABLE");
    expect(sub.earnedPaise).toBe(36_000n); // 12,000 views × ₹30/1K
    await ledgerOk();
  });

  it("claws back a paid submission, leaves a negative wallet, flags the clipper and blocks withdrawals", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id);
    const res = await submitAt(clipper, campaign.id, reelUrl("clean_viral"), daysAgo(20));
    await catchUpSubmission(res.submission.id);
    await savePayoutProfile(
      clipper.user.id,
      { legalName: "Ravi Kumar", upiId: "ravi@ybl" },
      userActor(clipper.user.id),
    );
    const earned = (await db.submission.findUniqueOrThrow({ where: { id: res.submission.id } })).earnedPaise;
    expect(earned).toBeGreaterThan(50_000n);
    await requestWithdrawal(clipper.user.id, "req-claw-01", userActor(clipper.user.id));
    const admin = await makeUser(["ADMIN"], "Admin");
    const batch = await createPayoutBatch(admin.id, userActor(admin.id));
    await approvePayoutBatch(batch.id, admin.id, userActor(admin.id), mockProvider());
    await syncProcessingPayouts(mockProvider());

    await adminVoidSubmission(
      res.submission.id,
      admin.id,
      "Clip re-uploaded from another creator",
      userActor(admin.id),
    );
    const sub = await db.submission.findUniqueOrThrow({ where: { id: res.submission.id } });
    expect(sub.status).toBe("CLAWED_BACK");
    expect(await balance(db, acct.clipperPayable(clipper.user.id))).toBe(-earned);
    const user = await db.user.findUniqueOrThrow({ where: { id: clipper.user.id } });
    expect(user.flaggedAt).not.toBeNull();
    await expect(
      requestWithdrawal(clipper.user.id, "req-claw-02", userActor(clipper.user.id)),
    ).rejects.toThrow(PayoutError);
    await ledgerOk();
  });

  it("returns a failed payout to the wallet", async () => {
    const { campaign } = await makeActiveCampaign();
    const clipper = await joined(campaign.id);
    const res = await submitAt(clipper, campaign.id, reelUrl("clean_viral"), daysAgo(20));
    await catchUpSubmission(res.submission.id);
    await savePayoutProfile(
      clipper.user.id,
      { legalName: "Fail Case", upiId: "fail.case@ybl" },
      userActor(clipper.user.id),
    );
    const payout = await requestWithdrawal(clipper.user.id, "req-fail-01", userActor(clipper.user.id));
    const admin = await makeUser(["ADMIN"], "Admin");
    const batch = await createPayoutBatch(admin.id, userActor(admin.id));
    await approvePayoutBatch(batch.id, admin.id, userActor(admin.id), mockProvider());
    await syncProcessingPayouts(mockProvider());
    expect((await db.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("FAILED");
    expect(await balance(db, acct.clipperPayable(clipper.user.id))).toBe(payout.grossPaise);
    expect((await db.submission.findUniqueOrThrow({ where: { id: res.submission.id } })).status).toBe(
      "PAYABLE",
    );
    expect((await db.payoutBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      "PARTIALLY_FAILED",
    );
    await ledgerOk();
  });

  it("exhausts a small budget and re-activates when a void returns money", async () => {
    const { campaign } = await makeActiveCampaign({
      budgetPaise: 1_000_00n,
      maxPayoutPerSubmissionPaise: null,
    });
    const a = await joined(campaign.id);
    const b = await joined(campaign.id);
    const r1 = await submitAt(a, campaign.id, reelUrl("clean_viral"), daysAgo(3));
    await submitAt(b, campaign.id, reelUrl("clean_viral"), daysAgo(3));
    await catchUpSubmission(r1.submission.id);
    const c = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(c.status).toBe("EXHAUSTED");
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(0n);
    expect(await db.notification.count({ where: { kind: "BUDGET_EXHAUSTED" } })).toBeGreaterThanOrEqual(2);

    const admin = await makeUser(["ADMIN"], "Admin");
    await adminVoidSubmission(r1.submission.id, admin.id, "Test void to release budget", userActor(admin.id));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ACTIVE");
    await ledgerOk();
  });
});
