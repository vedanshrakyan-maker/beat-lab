import type { Prisma, Submission } from "@prisma/client";
import { z } from "zod";
import { audit, type Actor } from "@/lib/audit";
import { db, type DbOrTx } from "@/lib/db";
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, saveUpload } from "@/lib/storage";
import { accrue } from "@/domain/accrual";
import { runFraud } from "@/domain/fraud-context";
import {
  applyFraudDecision,
  makePayable,
  processHoldEnds,
  REVIEWABLE_STATUSES,
  setStatus,
  startTracking,
  voidSubmission,
} from "@/domain/lifecycle";
import { notify } from "@/domain/notifications";
import { SLOT_HOLD_END } from "@/domain/schedule";

/**
 * Admin review actions. Every decision requires a reason, is audit-logged, and is stored
 * as a ReviewDecision (a training label for a future ML fraud model).
 */

export class ReviewError extends Error {}

export const reasonSchema = z.string().trim().min(5, "Give a reason (at least 5 characters)").max(1000);

async function lockForReview(tx: DbOrTx, submissionId: string): Promise<Submission> {
  const pre = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { campaignId: true },
  });
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${pre.campaignId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${submissionId} FOR UPDATE`;
  return tx.submission.findUniqueOrThrow({ where: { id: submissionId } });
}

async function recordDecision(
  tx: DbOrTx,
  sub: Submission,
  adminId: string,
  decision: "APPROVE" | "REJECT" | "VOID",
  reason: string,
) {
  const signals = await tx.fraudSignal.findMany({
    where: { submissionId: sub.id },
    orderBy: { createdAt: "asc" },
  });
  return tx.reviewDecision.create({
    data: {
      submissionId: sub.id,
      adminId,
      decision,
      reason,
      fraudScore: sub.fraudScore,
      signals: signals.map((s) => ({
        phase: s.phase,
        ruleKey: s.ruleKey,
        score: s.score,
        weight: s.weight,
        evidence: s.evidence,
      })) as Prisma.InputJsonValue,
    },
  });
}

export async function approveSubmission(
  submissionId: string,
  adminId: string,
  rawReason: string,
  actor: Actor,
  now = new Date(),
) {
  const reason = reasonSchema.parse(rawReason);
  const result = await db.$transaction(
    async (tx) => {
      const sub = await lockForReview(tx, submissionId);
      if (!REVIEWABLE_STATUSES.includes(sub.status))
        throw new ReviewError(`A ${sub.status} submission can't be approved`);
      const decision = await recordDecision(tx, sub, adminId, "APPROVE", reason);
      const latest = await tx.metricSnapshot.findFirst({
        where: { submissionId },
        orderBy: { capturedAt: "desc" },
      });

      if (sub.status === "UNDER_REVIEW") {
        await startTracking(tx, submissionId, actor, now);
      } else if (sub.status === "FLAGGED") {
        const restore = sub.statusBeforeFlag ?? "TRACKING";
        await setStatus(tx, sub, restore, actor, { statusBeforeFlag: null }, reason);
      }
      await tx.submission.update({
        where: { id: submissionId },
        data: { reviewState: "CLEARED", reviewClearedScore: sub.fraudScore },
      });
      const after = await tx.submission.findUniqueOrThrow({ where: { id: submissionId } });
      if (after.status === "TRACKING" && latest) {
        await accrue(tx, submissionId, latest.views, `accrual:${submissionId}:approve:${decision.id}`);
      }
      await audit(
        tx,
        actor,
        "submission.review.approve",
        "Submission",
        submissionId,
        { status: sub.status, reviewState: sub.reviewState },
        { status: after.status, reason },
      );
      if (sub.status !== "UNDER_REVIEW") {
        const c = await tx.campaign.findUniqueOrThrow({
          where: { id: sub.campaignId },
          select: { title: true },
        });
        await notify(
          tx,
          sub.clipperId,
          "SUBMISSION_APPROVED",
          { campaign: c.title },
          `/clipper/submissions/${submissionId}`,
        );
      }
      const holdChecked = await tx.metricSnapshot.findUnique({
        where: { submissionId_slot: { submissionId, slot: SLOT_HOLD_END } },
      });
      return { status: after.status, holdEndsAt: after.holdEndsAt, holdChecked: !!holdChecked };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  // A held submission whose hold already ended: clear it now instead of waiting for the sweep.
  if (result.status === "HELD" && result.holdEndsAt && result.holdEndsAt <= now) {
    if (result.holdChecked) {
      await db.$transaction((tx) => makePayable(tx, submissionId, actor, now), {
        maxWait: 10_000,
        timeout: 30_000,
      });
    } else {
      await processHoldEnds({ now, submissionIds: [submissionId] });
    }
  }
}

/** Reject a submission that was never approved (pre-tracking). */
export async function rejectSubmission(
  submissionId: string,
  adminId: string,
  rawReason: string,
  actor: Actor,
) {
  const reason = reasonSchema.parse(rawReason);
  await db.$transaction(async (tx) => {
    const sub = await lockForReview(tx, submissionId);
    if (sub.status !== "UNDER_REVIEW" && sub.status !== "SUBMITTED") {
      throw new ReviewError("Only submissions awaiting approval can be rejected; void approved ones instead");
    }
    await recordDecision(tx, sub, adminId, "REJECT", reason);
    await setStatus(
      tx,
      sub,
      "REJECTED",
      actor,
      { rejectionReason: reason, reviewState: "CLEARED", nextSnapshotAt: null },
      reason,
    );
    const c = await tx.campaign.findUniqueOrThrow({ where: { id: sub.campaignId }, select: { title: true } });
    await notify(
      tx,
      sub.clipperId,
      "SUBMISSION_REJECTED",
      { campaign: c.title, reason },
      `/clipper/submissions/${submissionId}`,
    );
  });
}

/** Void any approved submission (releases reserved earnings or claws back cleared ones). */
export async function adminVoidSubmission(
  submissionId: string,
  adminId: string,
  rawReason: string,
  actor: Actor,
  now = new Date(),
) {
  const reason = reasonSchema.parse(rawReason);
  await db.$transaction(
    async (tx) => {
      const sub = await lockForReview(tx, submissionId);
      if (["VOIDED", "CLAWED_BACK", "REJECTED"].includes(sub.status)) throw new ReviewError("Already closed");
      await recordDecision(tx, sub, adminId, "VOID", reason);
      await tx.submission.update({ where: { id: submissionId }, data: { reviewState: "CLEARED" } });
      await voidSubmission(tx, submissionId, reason, actor, now);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Manual metrics (Section 6.4)
// ---------------------------------------------------------------------------

export const manualMetricsSchema = z.object({
  views: z.coerce.number().int().min(0).max(1_000_000_000),
  likes: z.coerce.number().int().min(0),
  comments: z.coerce.number().int().min(0),
  shares: z.coerce.number().int().min(0),
  reach: z.coerce.number().int().min(0).nullable().optional(),
  saves: z.coerce.number().int().min(0).nullable().optional(),
  capturedAt: z.coerce.date().optional(),
  note: z.string().max(1000).optional(),
});
export type ManualMetricsInput = z.input<typeof manualMetricsSchema>;

export async function enterManualMetrics(
  submissionId: string,
  adminId: string,
  rawInput: ManualMetricsInput,
  actor: Actor,
  now = new Date(),
) {
  const input = manualMetricsSchema.parse(rawInput);
  const capturedAt = input.capturedAt ?? now;
  if (capturedAt > now) throw new ReviewError("Capture time can't be in the future");
  await db.$transaction(
    async (tx) => {
      const sub = await lockForReview(tx, submissionId);
      if (!["UNDER_REVIEW", "TRACKING", "FLAGGED", "HELD"].includes(sub.status)) {
        throw new ReviewError(`Can't enter metrics for a ${sub.status} submission`);
      }
      const lowest = await tx.metricSnapshot.findFirst({
        where: { submissionId, slot: { lt: 0 } },
        orderBy: { slot: "asc" },
      });
      const slot = (lowest?.slot ?? 0) - 1;
      await tx.metricSnapshot.create({
        data: {
          submissionId,
          slot,
          capturedAt,
          views: input.views,
          likes: input.likes,
          comments: input.comments,
          shares: input.shares,
          reach: input.reach ?? null,
          saves: input.saves ?? null,
          source: "MANUAL",
          enteredById: adminId,
          rawPayload: { note: input.note ?? null, enteredBy: adminId },
        },
      });
      await tx.submission.update({ where: { id: submissionId }, data: { metricsSource: "MANUAL" } });
      await audit(tx, actor, "submission.manual_metrics", "Submission", submissionId, undefined, {
        ...input,
        slot,
      });
      const evaluation = await runFraud(tx, submissionId, "SNAPSHOT", now);
      await applyFraudDecision(tx, submissionId, evaluation, actor, now);
      await accrue(tx, submissionId, input.views, `accrual:${submissionId}:${slot}`);
      await tx.manualEvidence.updateMany({
        where: { submissionId, reviewedAt: null },
        data: { reviewedAt: now, reviewedById: adminId },
      });
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** Clipper uploads a screen recording of their in-app insights. */
export async function addManualEvidence(
  submissionId: string,
  userId: string,
  file: { name: string; type: string; size: number; bytes: Buffer },
  note: string | undefined,
  actor: Actor,
) {
  const sub = await db.submission.findUniqueOrThrow({ where: { id: submissionId } });
  if (sub.clipperId !== userId) throw new ReviewError("Not your submission");
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type))
    throw new ReviewError("Upload an MP4/MOV/WebM screen recording or a PNG/JPEG screenshot");
  if (file.size > MAX_UPLOAD_BYTES) throw new ReviewError("File is larger than 50 MB");
  const storageKey = await saveUpload(file.bytes, file.name);
  await db.$transaction(async (tx) => {
    const ev = await tx.manualEvidence.create({
      data: {
        submissionId,
        uploadedById: userId,
        fileName: file.name.slice(0, 200),
        mimeType: file.type,
        sizeBytes: file.size,
        storageKey,
        note,
      },
    });
    await audit(tx, actor, "submission.evidence_uploaded", "Submission", submissionId, undefined, {
      evidenceId: ev.id,
      fileName: ev.fileName,
    });
  });
}
