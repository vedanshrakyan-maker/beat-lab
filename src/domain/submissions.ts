import type { Platform, Submission } from "@prisma/client";
import { z } from "zod";
import { audit, type Actor } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { isUniqueViolation } from "@/ledger/ledger";
import { missingTags } from "@/fraud/rules/rule-violation-hints";
import { getAdapter } from "@/platforms";
import { defaultScenarioFor, isMockScenario } from "@/platforms/mock";
import type { PlatformAdapter } from "@/platforms/types";
import { detectPlatform, mockScenarioFromUrl, parseYouTubeUrl } from "@/platforms/urls";
import { YT_SHORTS_MAX_SECONDS } from "@/platforms/youtube";
import { accrue, capViewsFor } from "@/domain/accrual";
import { acceptsSubmissions, parseRules } from "@/domain/campaigns";
import { runFraud } from "@/domain/fraud-context";
import { applyFraudDecision, routeToManual, setStatus, startTracking } from "@/domain/lifecycle";
import { notify } from "@/domain/notifications";
import { addDays, snapshotDueAt } from "@/domain/schedule";

export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export async function joinCampaign(userId: string, campaignId: string, actor: Actor) {
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (!acceptsSubmissions(campaign))
    throw new SubmissionError("This campaign is not accepting clippers right now", "CAMPAIGN_CLOSED");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.status !== "ACTIVE") throw new SubmissionError("Your account is not active", "USER_INACTIVE");
  return db.$transaction(async (tx) => {
    const participation = await tx.campaignParticipation.upsert({
      where: { campaignId_clipperId: { campaignId, clipperId: userId } },
      create: { campaignId, clipperId: userId },
      update: { status: "ACTIVE" },
    });
    await audit(tx, actor, "campaign.join", "Campaign", campaignId, undefined, { clipperId: userId });
    return participation;
  });
}

// ---------------------------------------------------------------------------
// Submitting a post
// ---------------------------------------------------------------------------

export const submitPostSchema = z.object({
  campaignId: z.string().min(1),
  socialAccountId: z.string().min(1),
  postUrl: z.string().trim().url("Paste the full link to your post").max(500),
  /** Dev/test only: force a MockAdapter scenario. Ignored by real adapters. */
  mockScenario: z.string().optional(),
});
export type SubmitPostInput = z.infer<typeof submitPostSchema>;

export interface RuleCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SubmitResult {
  submission: Submission;
  outcome: "TRACKING" | "UNDER_REVIEW" | "REJECTED";
  checks: RuleCheck[];
  message: string;
}

export interface SubmitOptions {
  now?: Date;
  adapterFor?: (platform: Platform) => PlatformAdapter;
}

export async function submitPost(
  userId: string,
  rawInput: SubmitPostInput,
  actor: Actor,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const input = submitPostSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const checks: RuleCheck[] = [];

  const [campaign, account, participation, user] = await Promise.all([
    db.campaign.findUnique({ where: { id: input.campaignId } }),
    db.socialAccount.findUnique({ where: { id: input.socialAccountId } }),
    db.campaignParticipation.findUnique({
      where: { campaignId_clipperId: { campaignId: input.campaignId, clipperId: userId } },
    }),
    db.user.findUniqueOrThrow({ where: { id: userId } }),
  ]);
  if (!campaign) throw new SubmissionError("Campaign not found", "NOT_FOUND");
  if (user.status !== "ACTIVE") throw new SubmissionError("Your account is not active", "USER_INACTIVE");
  if (!acceptsSubmissions(campaign, now))
    throw new SubmissionError("This campaign is not accepting submissions", "CAMPAIGN_CLOSED");
  if (!participation || participation.status !== "ACTIVE")
    throw new SubmissionError("Join the campaign before submitting", "NOT_JOINED");
  if (!account || account.userId !== userId)
    throw new SubmissionError("Choose one of your connected accounts", "ACCOUNT");
  if (account.status !== "VERIFIED")
    throw new SubmissionError("Verify this account before submitting from it", "ACCOUNT_UNVERIFIED");

  const platform = detectPlatform(input.postUrl);
  if (!platform)
    throw new SubmissionError("That doesn't look like an Instagram Reel or YouTube Short link", "BAD_URL");
  if (platform === "X") throw new SubmissionError("X is not supported yet", "PLATFORM_UNSUPPORTED");
  if (platform !== account.platform) {
    throw new SubmissionError(
      `This is a ${platform.toLowerCase()} link but the selected account is on ${account.platform.toLowerCase()}`,
      "PLATFORM_MISMATCH",
    );
  }
  if (!campaign.allowedPlatforms.includes(platform))
    throw new SubmissionError(
      `This campaign doesn't accept ${platform.toLowerCase()} posts`,
      "PLATFORM_NOT_ALLOWED",
    );
  checks.push({ label: "Platform allowed", ok: true, detail: platform });
  checks.push({ label: "Account ownership verified", ok: true, detail: `@${account.handle}` });

  const adapter = opts.adapterFor?.(platform) ?? getAdapter(platform, { now: () => now });
  const parsed = adapter.parsePostUrl(input.postUrl);
  if (!parsed) throw new SubmissionError("We couldn't read a post id from that link", "BAD_URL");

  const duplicate = await db.submission.findUnique({
    where: { platform_platformPostId: { platform, platformPostId: parsed.platformPostId } },
  });
  if (duplicate) {
    await recordDuplicate(userId, platform, parsed.platformPostId, duplicate.id, actor);
    throw new SubmissionError("This post has already been submitted", "DUPLICATE");
  }

  const rules = parseRules(campaign.rules);
  const scenarioFromUrl = mockScenarioFromUrl(input.postUrl);
  const mockScenario =
    adapter.mode === "mock"
      ? isMockScenario(scenarioFromUrl)
        ? scenarioFromUrl
        : isMockScenario(input.mockScenario)
          ? input.mockScenario
          : defaultScenarioFor(parsed.platformPostId)
      : null;

  const metrics = (
    await adapter.fetchPostMetrics([
      {
        platformPostId: parsed.platformPostId,
        accessToken: account.encryptedAccessToken ? decrypt(account.encryptedAccessToken) : null,
        platformAccountId: account.platformAccountId,
        publishedAt: now,
        mock: {
          scenario: mockScenario,
          capViews: capViewsFor(campaign),
          captionTags: [...rules.requiredHashtags, ...rules.requiredMentions],
        },
      },
    ])
  ).get(parsed.platformPostId);

  let metricsAvailable = true;
  if (!metrics || !metrics.ok) {
    const error = metrics?.error ?? "ERROR";
    if (error === "NOT_FOUND")
      throw new SubmissionError(
        "We couldn't find that post. Is it public and on your connected account?",
        "POST_NOT_FOUND",
      );
    if (error === "TOKEN_REVOKED")
      throw new SubmissionError("We lost access to your account. Please reconnect it.", "TOKEN_REVOKED");
    if (error === "INSIGHTS_UNAVAILABLE") {
      metricsAvailable = false;
      checks.push({
        label: "Insights available",
        ok: false,
        detail: "We'll ask you for a screen recording of your insights",
      });
    } else {
      throw new SubmissionError(
        "The platform didn't respond. Please try again in a minute.",
        "PLATFORM_ERROR",
      );
    }
  }

  if (metrics?.ok) {
    if (metrics.ownerAccountId && metrics.ownerAccountId !== account.platformAccountId) {
      throw new SubmissionError("This post isn't from your connected account", "NOT_OWNER");
    }
    if (platform === "YOUTUBE") {
      const shortsUrl = parseYouTubeUrl(input.postUrl)?.isShortsUrl ?? false;
      const shortByDuration = metrics.durationSec !== null && metrics.durationSec <= YT_SHORTS_MAX_SECONDS;
      if (!shortsUrl && !shortByDuration)
        throw new SubmissionError("Only YouTube Shorts (3 minutes or less) are eligible", "NOT_A_SHORT");
      checks.push({
        label: "YouTube Short",
        ok: true,
        detail: metrics.durationSec ? `${metrics.durationSec}s` : "shorts link",
      });
    }
    if (metrics.durationSec !== null) {
      if (rules.minDurationSec && metrics.durationSec < rules.minDurationSec) {
        throw new SubmissionError(
          `Clips must be at least ${rules.minDurationSec}s (yours is ${metrics.durationSec}s)`,
          "TOO_SHORT",
        );
      }
      if (rules.maxDurationSec && metrics.durationSec > rules.maxDurationSec) {
        throw new SubmissionError(
          `Clips must be at most ${rules.maxDurationSec}s (yours is ${metrics.durationSec}s)`,
          "TOO_LONG",
        );
      }
      checks.push({ label: "Duration", ok: true, detail: `${metrics.durationSec}s` });
    }
    if (metrics.caption !== null && rules.requiredHashtags.length + rules.requiredMentions.length > 0) {
      const missing = missingTags(metrics.caption, rules.requiredHashtags, rules.requiredMentions);
      checks.push({
        label: "Required hashtags & mentions",
        ok: missing.length === 0,
        detail: missing.length ? `Missing ${missing.join(", ")}` : "All present",
      });
    }
  }

  const polling = await getSetting("polling");
  try {
    return await db.$transaction(
      async (tx) => {
        const submission = await tx.submission.create({
          data: {
            campaignId: campaign.id,
            clipperId: userId,
            socialAccountId: account.id,
            platform,
            postUrl: input.postUrl,
            platformPostId: parsed.platformPostId,
            platformMediaId: metrics?.ok ? metrics.platformMediaId : null,
            caption: metrics?.ok ? metrics.caption : null,
            metricsSource: metrics?.ok ? metrics.source : "UNAVAILABLE",
            mockScenario,
            submittedAt: now,
            trackingStartedAt: now,
            trackingEndsAt: addDays(now, campaign.trackingWindowDays),
            nextSnapshotSlot: 1,
            nextSnapshotAt: metricsAvailable
              ? snapshotDueAt(now, 1, campaign.trackingWindowDays, polling)
              : null,
          },
        });
        await audit(tx, actor, "submission.create", "Submission", submission.id, undefined, {
          postUrl: submission.postUrl,
          platform,
          campaignId: campaign.id,
        });

        if (!metrics?.ok) {
          await setStatus(
            tx,
            submission,
            "UNDER_REVIEW",
            actor,
            {},
            "Metrics unavailable: manual verification",
          );
          await routeToManual(tx, submission, metrics?.message ?? "Insights unavailable");
          const s = await tx.submission.findUniqueOrThrow({ where: { id: submission.id } });
          return {
            submission: s,
            outcome: "UNDER_REVIEW" as const,
            checks,
            message:
              "Insights aren't available for this post, so we'll verify it manually. Upload a screen recording of your insights.",
          };
        }

        await tx.metricSnapshot.create({
          data: {
            submissionId: submission.id,
            slot: 0,
            capturedAt: now,
            views: metrics.views,
            reach: metrics.reach,
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
            saves: metrics.saves,
            source: metrics.source,
            rawPayload: metrics.raw as object,
          },
        });

        const evaluation = await runFraud(tx, submission.id, "SUBMIT", now);
        if (evaluation.decision === "AUTO_REJECT") {
          await applyFraudDecision(tx, submission.id, evaluation, actor, now);
          const s = await tx.submission.findUniqueOrThrow({ where: { id: submission.id } });
          return {
            submission: s,
            outcome: "REJECTED" as const,
            checks,
            message: s.rejectionReason ?? "Rejected",
          };
        }
        if (evaluation.decision === "AUTO_APPROVE") {
          await startTracking(tx, submission.id, actor, now);
          await accrue(tx, submission.id, metrics.views, `accrual:${submission.id}:0`);
          const s = await tx.submission.findUniqueOrThrow({ where: { id: submission.id } });
          return {
            submission: s,
            outcome: "TRACKING" as const,
            checks,
            message: "Approved — we're tracking your views now.",
          };
        }
        await setStatus(
          tx,
          submission,
          "UNDER_REVIEW",
          actor,
          { reviewState: "NEEDS_REVIEW" },
          `Fraud score ${evaluation.score}`,
        );
        await notify(
          tx,
          userId,
          "SUBMISSION_UNDER_REVIEW",
          { campaign: campaign.title },
          `/clipper/submissions/${submission.id}`,
        );
        const s = await tx.submission.findUniqueOrThrow({ where: { id: submission.id } });
        return {
          submission: s,
          outcome: "UNDER_REVIEW" as const,
          checks,
          message: "Submitted — a quick manual review is needed. We keep tracking views meanwhile.",
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await db.submission.findUnique({
        where: { platform_platformPostId: { platform, platformPostId: parsed.platformPostId } },
      });
      if (existing) await recordDuplicate(userId, platform, parsed.platformPostId, existing.id, actor);
      throw new SubmissionError("This post has already been submitted", "DUPLICATE");
    }
    throw e;
  }
}

async function recordDuplicate(
  userId: string,
  platform: Platform,
  platformPostId: string,
  existingSubmissionId: string,
  actor: Actor,
) {
  await db.$transaction(async (tx) => {
    const attempt = await tx.duplicateAttempt.create({
      data: { userId, platform, platformPostId, existingSubmissionId },
    });
    await audit(tx, actor, "submission.duplicate_attempt", "DuplicateAttempt", attempt.id, undefined, {
      platform,
      platformPostId,
      existingSubmissionId,
    });
  });
}
