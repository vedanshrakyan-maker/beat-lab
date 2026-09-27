import type { Platform } from "@prisma/client";
import type { FraudRuleKey, FraudSettings } from "@/lib/settings";
import type { PostExistence } from "@/platforms/types";

export type FraudPhase = "SUBMIT" | "SNAPSHOT" | "LOCK" | "HOLD_END";

export interface SnapshotPoint {
  capturedAt: Date;
  views: number;
  reach: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
  source: "API" | "MANUAL" | "MOCK" | "UNAVAILABLE";
}

/** Everything a rule may look at. Rules are pure functions of this object. */
export interface FraudContext {
  phase: FraudPhase;
  now: Date;
  submission: {
    id?: string;
    platform: Platform;
    platformPostId: string;
    caption: string | null;
    /** When tracking started (or submission time before approval). */
    startedAt: Date;
    lockedViews: number | null;
    metricsSource: "API" | "MANUAL" | "MOCK" | "UNAVAILABLE";
  };
  /** Sorted by capturedAt ascending. */
  snapshots: SnapshotPoint[];
  account: { handle: string; followerCount: number; accountCreatedAt: Date | null };
  history: {
    /** Median hourly view gain across this account's previous submissions (null if too little data). */
    medianHourlyGain: number | null;
    /** Times this clipper tried to submit a post that was already submitted. */
    duplicateAttempts: number;
  };
  campaign: {
    ratePer1kViewsPaise: bigint;
    maxPayoutPerSubmissionPaise: bigint | null;
    requiredHashtags: string[];
    requiredMentions: string[];
  };
  /** Result of the platform existence check (LOCK / HOLD_END), null if not checked. */
  postStatus: PostExistence | null;
  links: {
    /** Other clipper users sharing this user's UPI ID / PAN / device fingerprint. */
    sharedUpiUsers: number;
    sharedPanUsers: number;
    sharedDeviceUsers: number;
  };
  config: FraudSettings;
}

export interface FraudSignalResult {
  ruleKey: FraudRuleKey;
  /** 0–100 severity of this signal on its own. */
  score: number;
  /** Plain English for admins, with numbers. */
  explanation: string;
  /** Simplified wording shown to funders (no personal data). */
  funderExplanation: string;
  evidence: Record<string, unknown>;
  /** Hard outcomes that bypass scoring. */
  action?: "VOID" | "REJECT";
}

export type FraudRule = {
  key: FraudRuleKey;
  description: string;
  evaluate: (ctx: FraudContext) => FraudSignalResult | null;
};

export interface WeightedSignal extends FraudSignalResult {
  weight: number;
}

export type FraudDecision = "AUTO_APPROVE" | "MANUAL_REVIEW" | "AUTO_FLAG" | "AUTO_VOID" | "AUTO_REJECT";

export interface FraudEvaluation {
  phase: FraudPhase;
  score: number;
  decision: FraudDecision;
  signals: WeightedSignal[];
}
