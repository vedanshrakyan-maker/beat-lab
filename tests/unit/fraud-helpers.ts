import type { FraudContext, SnapshotPoint } from "@/fraud/types";
import { defaultFraudSettings } from "@/lib/settings";

export const T0 = new Date("2026-03-01T00:00:00Z");
const H = 3_600_000;

export function snap(hours: number, views: number, extra: Partial<SnapshotPoint> = {}): SnapshotPoint {
  const likes = Math.floor(views * 0.07);
  return {
    capturedAt: new Date(T0.getTime() + hours * H),
    views,
    reach: Math.floor(views / 1.4),
    likes,
    comments: Math.floor(likes * 0.05),
    shares: Math.floor(likes * 0.1),
    saves: null,
    source: "API",
    ...extra,
  };
}

export function ctx(overrides: Partial<FraudContext> = {}): FraudContext {
  const snapshots = overrides.snapshots ?? [snap(0, 100), snap(1, 900), snap(6, 5_000), snap(24, 12_000)];
  return {
    phase: "SNAPSHOT",
    now: snapshots[snapshots.length - 1]?.capturedAt ?? T0,
    submission: {
      platform: "INSTAGRAM",
      platformPostId: "ABC123",
      caption: "Great clip #reelpay @brandco",
      startedAt: T0,
      lockedViews: null,
      metricsSource: "API",
    },
    snapshots,
    account: {
      handle: "clipper",
      followerCount: 20_000,
      accountCreatedAt: new Date(T0.getTime() - 400 * 24 * H),
    },
    history: { medianHourlyGain: null, duplicateAttempts: 0 },
    campaign: {
      ratePer1kViewsPaise: 3000n,
      maxPayoutPerSubmissionPaise: 5_00_000n,
      requiredHashtags: ["#reelpay"],
      requiredMentions: ["@brandco"],
    },
    postStatus: null,
    links: { sharedUpiUsers: 0, sharedPanUsers: 0, sharedDeviceUsers: 0 },
    config: structuredClone(defaultFraudSettings),
    ...overrides,
  };
}
