import { evaluateFraud } from "@/fraud/engine";
import type { FraudContext, FraudDecision, FraudPhase, SnapshotPoint } from "@/fraud/types";
import { viewsForAmount } from "@/lib/money";
import { defaultFraudSettings, type FraudSettings } from "@/lib/settings";
import { MockAdapter, type MockScenario } from "@/platforms/mock";
import type { Platform } from "@prisma/client";

/**
 * Fraud simulation harness (no database): drives the MockAdapter through a full
 * submission lifecycle for each scenario and runs the fraud engine at every phase,
 * exactly as the worker does. Used by `npm run fraud:simulate` and the unit tests.
 */

export type ExpectedOutcome = "CLEAN" | "FRAUD" | "MANUAL_METRICS";

export const scenarioExpectations: Record<MockScenario, ExpectedOutcome> = {
  CLEAN_VIRAL: "CLEAN",
  CLEAN_SLOW: "CLEAN",
  SMALL_ACCOUNT_VIRAL: "CLEAN",
  BOTTED_SPIKE: "FRAUD",
  DELETED_AFTER_LOCK: "FRAUD",
  PLATEAU_AT_CAP: "FRAUD",
  LOW_ENGAGEMENT: "FRAUD",
  LOOPING: "FRAUD",
  VIEW_DROP: "FRAUD",
  MISSING_HASHTAG: "FRAUD",
  MULTI_ACCOUNT: "FRAUD",
  INSIGHTS_UNAVAILABLE: "MANUAL_METRICS",
};

export const SIM_CAMPAIGN = {
  ratePer1kViewsPaise: 3_000n, // ₹30 per 1K views
  maxPayoutPerSubmissionPaise: 5_00_000n, // ₹5,000
  requiredHashtags: ["#reelpay"],
  requiredMentions: ["@brandco"],
};

const HOUR = 3_600_000;
const SEVERITY: Record<FraudDecision, number> = {
  AUTO_APPROVE: 0,
  MANUAL_REVIEW: 1,
  AUTO_FLAG: 2,
  AUTO_REJECT: 3,
  AUTO_VOID: 4,
};

export interface SimulationResult {
  scenario: MockScenario;
  postId: string;
  expected: ExpectedOutcome;
  finalDecision: FraudDecision | "MANUAL_METRICS";
  maxScore: number;
  decidedAt: FraudPhase | null;
  topSignals: string[];
  passed: boolean;
}

export function trackingOffsetsHours(
  trackingWindowDays: number,
  initial = [0, 1, 6, 24],
  every = 24,
): number[] {
  const end = trackingWindowDays * 24;
  const offsets = initial.filter((h) => h < end);
  let next = (offsets[offsets.length - 1] ?? 0) + every;
  while (next < end) {
    offsets.push(next);
    next += every;
  }
  return offsets;
}

export function passes(expected: ExpectedOutcome, decision: FraudDecision | "MANUAL_METRICS"): boolean {
  if (expected === "CLEAN") return decision === "AUTO_APPROVE";
  if (expected === "MANUAL_METRICS") return decision === "MANUAL_METRICS";
  return decision === "AUTO_FLAG" || decision === "AUTO_VOID" || decision === "AUTO_REJECT";
}

export async function simulateScenario(
  scenario: MockScenario,
  postId: string,
  options: {
    platform?: Platform;
    config?: FraudSettings;
    trackingWindowDays?: number;
    holdPeriodDays?: number;
  } = {},
): Promise<SimulationResult> {
  const platform = options.platform ?? "INSTAGRAM";
  const config = options.config ?? defaultFraudSettings;
  const windowDays = options.trackingWindowDays ?? 7;
  const holdDays = options.holdPeriodDays ?? 7;
  const start = new Date("2026-01-05T06:00:00Z");
  let clock = start;
  const adapter = new MockAdapter(platform, () => clock);
  const capViews = Number(
    viewsForAmount(SIM_CAMPAIGN.maxPayoutPerSubmissionPaise, SIM_CAMPAIGN.ratePer1kViewsPaise),
  );
  const post = {
    platformPostId: postId,
    publishedAt: start,
    mock: {
      scenario,
      capViews,
      captionTags: [...SIM_CAMPAIGN.requiredHashtags, ...SIM_CAMPAIGN.requiredMentions],
    },
  };

  const followerCount =
    scenario === "SMALL_ACCOUNT_VIRAL" ? 300 : scenario === "BOTTED_SPIKE" ? 1_200 : 22_000;
  const snapshots: SnapshotPoint[] = [];
  let caption: string | null = null;
  let lockedViews: number | null = null;
  let worst: FraudDecision = "AUTO_APPROVE";
  let decidedAt: FraudPhase | null = null;
  let maxScore = 0;
  const signalKeys = new Set<string>();

  const run = (phase: FraudPhase, postStatus: FraudContext["postStatus"] = null) => {
    const ctx: FraudContext = {
      phase,
      now: clock,
      submission: {
        platform,
        platformPostId: postId,
        caption,
        startedAt: start,
        lockedViews,
        metricsSource: "MOCK",
      },
      snapshots,
      account: {
        handle: `sim_${scenario.toLowerCase()}`,
        followerCount,
        accountCreatedAt: new Date(start.getTime() - 400 * 24 * HOUR),
      },
      history: { medianHourlyGain: null, duplicateAttempts: 0 },
      campaign: SIM_CAMPAIGN,
      postStatus,
      links: {
        sharedUpiUsers: scenario === "MULTI_ACCOUNT" ? 1 : 0,
        sharedPanUsers: 0,
        sharedDeviceUsers: scenario === "MULTI_ACCOUNT" ? 2 : 0,
      },
      config,
    };
    const result = evaluateFraud(ctx);
    maxScore = Math.max(maxScore, result.score);
    result.signals.forEach((s) => signalKeys.add(`${s.ruleKey}(${s.score})`));
    if (SEVERITY[result.decision] > SEVERITY[worst]) {
      worst = result.decision;
      decidedAt = phase;
    }
    return result.decision;
  };

  const capture = async (at: Date): Promise<boolean> => {
    clock = at;
    const metrics = (await adapter.fetchPostMetrics([post])).get(postId);
    if (!metrics || !metrics.ok) return false;
    caption = metrics.caption;
    snapshots.push({
      capturedAt: at,
      views: metrics.views,
      reach: metrics.reach,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      saves: metrics.saves,
      source: "MOCK",
    });
    return true;
  };

  const finish = (): SimulationResult => {
    const expected = scenarioExpectations[scenario];
    return {
      scenario,
      postId,
      expected,
      finalDecision: worst,
      maxScore,
      decidedAt,
      topSignals: [...signalKeys],
      passed: passes(expected, worst),
    };
  };

  // SUBMIT: first metrics fetch (caption check) before approval.
  if (!(await capture(start))) {
    const expected = scenarioExpectations[scenario];
    return {
      scenario,
      postId,
      expected,
      finalDecision: "MANUAL_METRICS",
      maxScore: 0,
      decidedAt: null,
      topSignals: [],
      passed: passes(expected, "MANUAL_METRICS"),
    };
  }
  const atSubmit = run("SUBMIT");
  if (atSubmit === "AUTO_REJECT") return finish();

  // TRACKING snapshots (T+0 already captured).
  for (const h of trackingOffsetsHours(windowDays).slice(1)) {
    await capture(new Date(start.getTime() + h * HOUR));
    run("SNAPSHOT");
  }

  // LOCK
  const lockAt = new Date(start.getTime() + windowDays * 24 * HOUR);
  clock = lockAt;
  const lockStatus = await adapter.fetchPostExists(post);
  if (await capture(lockAt)) lockedViews = snapshots[snapshots.length - 1]!.views;
  if (run("LOCK", lockStatus) === "AUTO_VOID") return finish();

  // HOLD END re-check
  const holdEnd = new Date(lockAt.getTime() + holdDays * 24 * HOUR);
  clock = holdEnd;
  const holdStatus = await adapter.fetchPostExists(post);
  await capture(holdEnd);
  run("HOLD_END", holdStatus);
  return finish();
}

export async function simulateAll(
  seedsPerScenario = 10,
  config?: FraudSettings,
): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];
  for (const scenario of Object.keys(scenarioExpectations) as MockScenario[]) {
    for (let i = 0; i < seedsPerScenario; i++) {
      results.push(
        await simulateScenario(scenario, `SIM${scenario.slice(0, 4)}${i.toString().padStart(3, "0")}x`, {
          config,
        }),
      );
    }
  }
  return results;
}
