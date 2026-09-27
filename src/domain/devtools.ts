import type { Platform } from "@prisma/client";
import { audit, type Actor } from "@/lib/audit";
import { db } from "@/lib/db";
import { env } from "@/env";
import { getAdapter } from "@/platforms";
import { MockAdapter } from "@/platforms/mock";
import { lockDueSubmissions, pollDueSnapshots, processHoldEnds } from "@/domain/lifecycle";

/**
 * DEV-ONLY time travel. Real tracking takes weeks (7-day window + 7-day hold). With the
 * MockAdapter, whose metrics are a pure function of time since posting, we can shift a
 * submission's timestamps into the past and replay every due step with a virtual clock —
 * running exactly the same lifecycle code as the worker. Used by the seed, the e2e test
 * and the admin "fast-forward" button.
 */

export function devtoolsEnabled(): boolean {
  return env().APP_ENV !== "production";
}

const HOUR = 3_600_000;

function mockAdapterAt(now: Date) {
  return (platform: Platform) => {
    if (getAdapter(platform).mode !== "mock")
      throw new Error("Time travel needs the mock adapter for " + platform);
    return new MockAdapter(platform, () => now);
  };
}

/** Replay every due lifecycle step for one submission, in time order, up to `until`. */
export async function catchUpSubmission(submissionId: string, until = new Date()): Promise<number> {
  let steps = 0;
  for (let guard = 0; guard < 200; guard++) {
    const s = await db.submission.findUniqueOrThrow({ where: { id: submissionId } });
    const candidates: { at: Date; kind: "poll" | "lock" | "hold" }[] = [];
    if (
      s.nextSnapshotAt &&
      ["TRACKING", "UNDER_REVIEW", "FLAGGED"].includes(s.status) &&
      s.metricsSource !== "UNAVAILABLE"
    ) {
      candidates.push({ at: s.nextSnapshotAt, kind: "poll" });
    }
    if (s.status === "TRACKING" && s.trackingEndsAt) candidates.push({ at: s.trackingEndsAt, kind: "lock" });
    if (s.status === "HELD" && s.holdEndsAt && s.reviewState !== "NEEDS_REVIEW")
      candidates.push({ at: s.holdEndsAt, kind: "hold" });
    candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
    const next = candidates[0];
    if (!next || next.at > until) break;
    const opts = { now: next.at, submissionIds: [submissionId], adapterFor: mockAdapterAt(next.at) };
    const before = `${s.status}:${s.nextSnapshotSlot}:${s.reviewState}`;
    if (next.kind === "poll") await pollDueSnapshots(opts);
    else if (next.kind === "lock") await lockDueSubmissions(opts);
    else await processHoldEnds(opts);
    const after = await db.submission.findUniqueOrThrow({ where: { id: submissionId } });
    steps++;
    if (`${after.status}:${after.nextSnapshotSlot}:${after.reviewState}` === before) break; // no progress
  }
  return steps;
}

/** Shift a submission `hours` into the past, then replay what became due. */
export async function fastForwardSubmission(
  submissionId: string,
  hours: number,
  actor: Actor,
): Promise<number> {
  if (!devtoolsEnabled()) throw new Error("Dev tools are disabled in production");
  const ms = Math.round(hours * HOUR);
  const shift = (d: Date | null) => (d ? new Date(d.getTime() - ms) : d);
  await db.$transaction(async (tx) => {
    const s = await tx.submission.findUniqueOrThrow({ where: { id: submissionId } });
    await tx.submission.update({
      where: { id: submissionId },
      data: {
        submittedAt: shift(s.submittedAt)!,
        approvedAt: shift(s.approvedAt),
        trackingStartedAt: shift(s.trackingStartedAt),
        trackingEndsAt: shift(s.trackingEndsAt),
        nextSnapshotAt: shift(s.nextSnapshotAt),
        lockedAt: shift(s.lockedAt),
        holdEndsAt: shift(s.holdEndsAt),
        payableAt: shift(s.payableAt),
      },
    });
    await tx.$executeRaw`UPDATE "MetricSnapshot" SET "capturedAt" = "capturedAt" - (${ms} * interval '1 millisecond') WHERE "submissionId" = ${submissionId}`;
    await audit(tx, actor, "dev.fast_forward", "Submission", submissionId, undefined, { hours });
  });
  return catchUpSubmission(submissionId);
}

export async function fastForwardCampaign(campaignId: string, hours: number, actor: Actor): Promise<number> {
  const subs = await db.submission.findMany({
    where: { campaignId, status: { in: ["TRACKING", "UNDER_REVIEW", "FLAGGED", "HELD", "LOCKED"] } },
    select: { id: true },
  });
  let steps = 0;
  for (const s of subs) steps += await fastForwardSubmission(s.id, hours, actor);
  return steps;
}
