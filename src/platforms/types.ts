import type { Platform } from "@prisma/client";

export type { Platform };

/** Hints the MockAdapter uses to simulate a scenario. Ignored by real adapters. */
export interface MockHints {
  scenario?: string | null;
  /** View count at which the per-submission payout cap is reached (for PLATEAU_AT_CAP). */
  capViews?: number | null;
  /** Hashtags / mentions the mock caption should contain (dropped for MISSING_HASHTAG). */
  captionTags?: string[];
}

export interface PostRef {
  submissionId?: string;
  platformPostId: string;
  /** Resolved media id when it differs from the URL id (Instagram). */
  platformMediaId?: string | null;
  /** Decrypted OAuth access token of the owning account, when the platform needs one. */
  accessToken?: string | null;
  /** The account the post must belong to (used to verify ownership of the post). */
  platformAccountId?: string | null;
  /** When the post went live (the mock curves are a function of time since this). */
  publishedAt?: Date;
  mock?: MockHints;
}

export type MetricErrorCode =
  "NOT_FOUND" | "INSIGHTS_UNAVAILABLE" | "TOKEN_REVOKED" | "QUOTA_EXCEEDED" | "NOT_SUPPORTED" | "ERROR";

export interface MetricOk {
  ok: true;
  views: number;
  reach: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
  caption: string | null;
  durationSec: number | null;
  isShort: boolean | null;
  publishedAt: Date | null;
  ownerAccountId: string | null;
  platformMediaId: string | null;
  source: "API" | "MOCK";
  raw: unknown;
}

export interface MetricError {
  ok: false;
  error: MetricErrorCode;
  message: string;
}

export type MetricResult = MetricOk | MetricError;

export type PostExistence = "LIVE" | "DELETED" | "PRIVATE" | "UNKNOWN";

/** Decoupled from the Prisma model so adapters never see encrypted columns. */
export interface AccountRef {
  platformAccountId: string;
  handle: string;
  accessToken?: string | null;
  verificationCode?: string | null;
  mock?: { followerCount?: number; accountCreatedAt?: Date | null };
}

export interface VerificationResult {
  verified: boolean;
  method: "OAUTH" | "BIO_CODE" | "MANUAL";
  reason?: string;
}

export interface AccountProfile {
  platformAccountId: string;
  handle: string;
  followerCount: number;
  accountCreatedAt: Date | null;
  isProfessional: boolean;
}

export interface PlatformAdapter {
  platform: Platform;
  /** "mock" or "live" — shown on the admin health panel. */
  mode: "mock" | "live";
  /** Max posts per fetchPostMetrics call (YouTube videos.list takes 50 ids). */
  batchSize: number;
  parsePostUrl(url: string): { platformPostId: string } | null;
  verifyAccountOwnership(account: AccountRef): Promise<VerificationResult>;
  /** Batched. Keyed by platformPostId. */
  fetchPostMetrics(posts: PostRef[]): Promise<Map<string, MetricResult>>;
  fetchPostExists(post: PostRef): Promise<PostExistence>;
  fetchAccountProfile(account: AccountRef): Promise<AccountProfile>;
}

export class PlatformNotSupportedError extends Error {
  constructor(platform: string) {
    super(`${platform} is not supported yet`);
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
