import type { Platform } from "@prisma/client";
import { parseInstagramUrl, parseXUrl, parseYouTubeUrl } from "@/platforms/urls";
import type {
  AccountProfile,
  AccountRef,
  MetricResult,
  PlatformAdapter,
  PostExistence,
  PostRef,
  VerificationResult,
} from "@/platforms/types";

/**
 * Deterministic, seedable fake platform. Views follow realistic curves (fast growth in
 * the first 24–48h, then decay) and every fraud pattern in docs/FRAUD.md can be simulated
 * per submission via `mock.scenario`. Same inputs always give the same numbers.
 */

export const mockScenarios = [
  "CLEAN_VIRAL",
  "CLEAN_SLOW",
  "SMALL_ACCOUNT_VIRAL",
  "BOTTED_SPIKE",
  "DELETED_AFTER_LOCK",
  "PLATEAU_AT_CAP",
  "LOW_ENGAGEMENT",
  "LOOPING",
  "VIEW_DROP",
  "MISSING_HASHTAG",
  "MULTI_ACCOUNT",
  "INSIGHTS_UNAVAILABLE",
] as const;
export type MockScenario = (typeof mockScenarios)[number];

export function isMockScenario(value: string | null | undefined): value is MockScenario {
  return !!value && (mockScenarios as readonly string[]).includes(value);
}

/** Hours after publish when the DELETED_AFTER_LOCK post disappears (after a 7-day lock). */
export const MOCK_DELETE_AFTER_HOURS = 7 * 24 + 12;
/** Hours after publish when the platform purges fake views in VIEW_DROP. */
export const MOCK_VIEW_PURGE_AFTER_HOURS = 7 * 24 + 18;

// --- deterministic PRNG ----------------------------------------------------

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rand: () => number, min: number, max: number): number {
  return Math.floor(min + rand() * (max - min));
}

/** Default scenario for a post with no explicit scenario: mostly clean traffic. */
export function defaultScenarioFor(platformPostId: string): MockScenario {
  return hashString(platformPostId) % 3 === 0 ? "CLEAN_VIRAL" : "CLEAN_SLOW";
}

export interface MockPostState {
  views: number;
  reach: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
  existence: PostExistence;
  caption: string;
}

/** Saturating growth curve: share of the eventual total reached after `hours`. */
function saturate(hours: number, tauHours: number): number {
  if (hours <= 0) return 0;
  return 1 - Math.exp(-hours / tauHours);
}

/**
 * The simulated state of a post `hours` after it was published. Pure function of
 * (postId, scenario, hours, hints) — the heart of the mock.
 */
export function simulatePost(
  platformPostId: string,
  scenarioInput: string | null | undefined,
  hours: number,
  hints: { capViews?: number | null; captionTags?: string[] } = {},
): MockPostState {
  const scenario: MockScenario = isMockScenario(scenarioInput)
    ? scenarioInput
    : defaultScenarioFor(platformPostId);
  const rand = mulberry32(hashString(`${platformPostId}:${scenario}`));
  const h = Math.max(0, hours);

  let views: number;
  let engagementRate = 0.06 + rand() * 0.04; // likes per view for healthy clips: 6–10%
  let reachDivisor = 1.25 + rand() * 0.3; // views per unique account for healthy clips
  let existence: PostExistence = "LIVE";

  switch (scenario) {
    case "CLEAN_VIRAL": {
      const total = between(rand, 250_000, 900_000);
      views = total * saturate(h, 18);
      break;
    }
    case "SMALL_ACCOUNT_VIRAL": {
      const total = between(rand, 40_000, 90_000);
      views = total * saturate(h, 20);
      break;
    }
    case "CLEAN_SLOW":
    case "MULTI_ACCOUNT":
    case "MISSING_HASHTAG":
    case "INSIGHTS_UNAVAILABLE": {
      const total = between(rand, 6_000, 45_000);
      views = total * saturate(h, 60);
      break;
    }
    case "BOTTED_SPIKE": {
      // Small organic base, then a bought block of views ~3h in, then nothing.
      const organic = between(rand, 1_500, 3_000) * saturate(h, 30);
      const bought = h >= 3 ? between(rand, 55_000, 90_000) : 0;
      views = organic + bought;
      engagementRate = 0.06 * (organic / Math.max(1, views)); // bots don't like or comment
      break;
    }
    case "DELETED_AFTER_LOCK": {
      const total = between(rand, 90_000, 200_000);
      views = total * saturate(h, 24);
      if (h >= MOCK_DELETE_AFTER_HOURS) existence = "DELETED";
      break;
    }
    case "PLATEAU_AT_CAP": {
      const cap = hints.capViews && hints.capViews > 0 ? hints.capViews : 100_000;
      const organic = cap * 3 * saturate(h, 20);
      // Once the cap is reached the account stops pushing (bought) views: pinned within ±0.5%.
      const jitter = (rand() - 0.5) * 0.01;
      views = organic >= cap ? cap * (1 + jitter) : organic;
      break;
    }
    case "LOW_ENGAGEMENT": {
      const total = between(rand, 60_000, 120_000);
      views = total * saturate(h, 24);
      engagementRate = 0.0008; // 0.08%
      break;
    }
    case "LOOPING": {
      const total = between(rand, 60_000, 150_000);
      views = total * saturate(h, 24);
      reachDivisor = 5.5; // same few accounts replaying the reel
      break;
    }
    case "VIEW_DROP": {
      const total = between(rand, 80_000, 160_000);
      views = total * saturate(h, 20);
      if (h >= MOCK_VIEW_PURGE_AFTER_HOURS) views *= 0.55; // platform removed fake views
      break;
    }
  }

  const v = Math.floor(views);
  const likes = Math.floor(v * engagementRate);
  const comments = Math.floor(likes * 0.06);
  const shares = Math.floor(likes * 0.12);
  const saves = Math.floor(likes * 0.08);
  const tags = scenario === "MISSING_HASHTAG" ? [] : (hints.captionTags ?? []);
  const caption = `New clip 🔥 ${tags.join(" ")}`.trim();

  return {
    views: v,
    reach: Math.floor(v / reachDivisor),
    likes,
    comments,
    shares,
    saves,
    existence,
    caption,
  };
}

export class MockAdapter implements PlatformAdapter {
  readonly mode = "mock" as const;
  readonly batchSize = 50;

  constructor(
    readonly platform: Platform,
    private readonly now: () => Date = () => new Date(),
  ) {}

  parsePostUrl(url: string): { platformPostId: string } | null {
    if (this.platform === "YOUTUBE") return parseYouTubeUrl(url);
    if (this.platform === "INSTAGRAM") return parseInstagramUrl(url);
    return parseXUrl(url);
  }

  async verifyAccountOwnership(account: AccountRef): Promise<VerificationResult> {
    if (account.handle.toLowerCase().includes("unverified")) {
      return {
        verified: false,
        method: "OAUTH",
        reason: "Mock: handles containing 'unverified' fail verification",
      };
    }
    return { verified: true, method: account.verificationCode ? "BIO_CODE" : "OAUTH" };
  }

  private hoursSince(post: PostRef): number {
    const published = post.publishedAt ?? this.now();
    return (this.now().getTime() - published.getTime()) / 3_600_000;
  }

  async fetchPostMetrics(posts: PostRef[]): Promise<Map<string, MetricResult>> {
    const out = new Map<string, MetricResult>();
    for (const post of posts) {
      const scenario = post.mock?.scenario;
      if (scenario === "INSIGHTS_UNAVAILABLE" && this.platform === "INSTAGRAM") {
        out.set(post.platformPostId, {
          ok: false,
          error: "INSIGHTS_UNAVAILABLE",
          message: "Mock: reel insights unavailable for this account (e.g. under ~1,000 followers)",
        });
        continue;
      }
      const hours = this.hoursSince(post);
      const s = simulatePost(post.platformPostId, scenario, hours, post.mock ?? {});
      if (s.existence !== "LIVE") {
        out.set(post.platformPostId, {
          ok: false,
          error: "NOT_FOUND",
          message: `Mock: post is ${s.existence}`,
        });
        continue;
      }
      out.set(post.platformPostId, {
        ok: true,
        views: s.views,
        reach: this.platform === "INSTAGRAM" ? s.reach : null,
        likes: s.likes,
        comments: s.comments,
        shares: this.platform === "YOUTUBE" ? 0 : s.shares,
        saves: this.platform === "INSTAGRAM" ? s.saves : null,
        caption: s.caption,
        durationSec: 30 + (hashString(post.platformPostId) % 30),
        isShort: true,
        publishedAt: post.publishedAt ?? null,
        ownerAccountId: post.platformAccountId ?? null,
        platformMediaId: post.platformMediaId ?? post.platformPostId,
        source: "MOCK",
        raw: {
          mock: true,
          scenario: scenario ?? defaultScenarioFor(post.platformPostId),
          hours: Math.round(hours * 100) / 100,
        },
      });
    }
    return out;
  }

  async fetchPostExists(post: PostRef): Promise<PostExistence> {
    return simulatePost(post.platformPostId, post.mock?.scenario, this.hoursSince(post)).existence;
  }

  async fetchAccountProfile(account: AccountRef): Promise<AccountProfile> {
    const rand = mulberry32(hashString(account.platformAccountId));
    return {
      platformAccountId: account.platformAccountId,
      handle: account.handle,
      followerCount: account.mock?.followerCount ?? between(rand, 2_000, 80_000),
      accountCreatedAt:
        account.mock?.accountCreatedAt ??
        new Date(this.now().getTime() - between(rand, 200, 2000) * 86_400_000),
      isProfessional: true,
    };
  }
}
