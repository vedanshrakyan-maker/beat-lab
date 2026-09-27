import { parseYouTubeUrl } from "@/platforms/urls";
import type { QuotaTracker } from "@/platforms/quota";
import {
  chunk,
  type AccountProfile,
  type AccountRef,
  type MetricResult,
  type PlatformAdapter,
  type PostExistence,
  type PostRef,
  type VerificationResult,
} from "@/platforms/types";

/**
 * YouTube Data API v3 adapter.
 * - videos.list with part=statistics,snippet,status,contentDetails, batched 50 ids/request
 *   (1 quota unit per call). NEVER use search.list (100 units).
 * - Views are the public statistics.viewCount.
 * - Ownership: OAuth `channels.list?mine=true` preferred; fallback is a verification code
 *   placed in the channel description, read with channels.list part=snippet.
 * See docs/PLATFORMS.md.
 */

const API = "https://www.googleapis.com/youtube/v3";
export const YT_MAX_IDS_PER_CALL = 50;
export const YT_SHORTS_MAX_SECONDS = 180;

type FetchFn = typeof fetch;

export class QuotaExhaustedError extends Error {}

/** ISO-8601 duration ("PT1M5S", "P0D", "PT2H") to seconds. */
export function parseIsoDuration(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

interface YtVideo {
  id: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    title?: string;
    description?: string;
    tags?: string[];
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  status?: { privacyStatus?: string; uploadStatus?: string };
  contentDetails?: { duration?: string };
}

interface YtChannel {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; publishedAt?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "YOUTUBE" as const;
  readonly mode = "live" as const;
  readonly batchSize = YT_MAX_IDS_PER_CALL;

  constructor(
    private readonly apiKey: string,
    private readonly quota: QuotaTracker,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  parsePostUrl(url: string) {
    const parsed = parseYouTubeUrl(url);
    return parsed ? { platformPostId: parsed.platformPostId } : null;
  }

  private async get<T>(path: string, params: Record<string, string>, bearer?: string | null): Promise<T> {
    if (!(await this.quota.canSpend(1)))
      throw new QuotaExhaustedError("YouTube daily quota nearly exhausted");
    const qs = new URLSearchParams(params);
    if (!bearer) qs.set("key", this.apiKey);
    const res = await this.fetchFn(`${API}/${path}?${qs.toString()}`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
    await this.quota.record(1);
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 403 && body.includes("quotaExceeded"))
        throw new QuotaExhaustedError("YouTube quotaExceeded");
      throw new Error(`YouTube ${path} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async fetchVideos(ids: string[]): Promise<Map<string, YtVideo>> {
    const out = new Map<string, YtVideo>();
    for (const batch of chunk([...new Set(ids)], YT_MAX_IDS_PER_CALL)) {
      const data = await this.get<{ items?: YtVideo[] }>("videos", {
        part: "statistics,snippet,status,contentDetails",
        id: batch.join(","),
        maxResults: String(YT_MAX_IDS_PER_CALL),
      });
      for (const item of data.items ?? []) out.set(item.id, item);
    }
    return out;
  }

  async fetchPostMetrics(posts: PostRef[]): Promise<Map<string, MetricResult>> {
    const out = new Map<string, MetricResult>();
    let videos: Map<string, YtVideo>;
    try {
      videos = await this.fetchVideos(posts.map((p) => p.platformPostId));
    } catch (e) {
      const quota = e instanceof QuotaExhaustedError;
      for (const p of posts) {
        out.set(p.platformPostId, {
          ok: false,
          error: quota ? "QUOTA_EXCEEDED" : "ERROR",
          message: e instanceof Error ? e.message : "YouTube request failed",
        });
      }
      return out;
    }
    for (const post of posts) {
      const v = videos.get(post.platformPostId);
      if (!v) {
        // Deleted and private videos are simply absent from videos.list results.
        out.set(post.platformPostId, {
          ok: false,
          error: "NOT_FOUND",
          message: "Video not found, deleted or private",
        });
        continue;
      }
      const durationSec = parseIsoDuration(v.contentDetails?.duration);
      const caption = [
        v.snippet?.title,
        v.snippet?.description,
        (v.snippet?.tags ?? []).map((t) => `#${t}`).join(" "),
      ]
        .filter(Boolean)
        .join("\n");
      out.set(post.platformPostId, {
        ok: true,
        views: Number(v.statistics?.viewCount ?? 0),
        reach: null, // not available from the public Data API
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
        shares: 0,
        saves: null,
        caption,
        durationSec,
        isShort: durationSec !== null ? durationSec <= YT_SHORTS_MAX_SECONDS : null,
        publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
        ownerAccountId: v.snippet?.channelId ?? null,
        platformMediaId: v.id,
        source: "API",
        raw: v,
      });
    }
    return out;
  }

  async fetchPostExists(post: PostRef): Promise<PostExistence> {
    try {
      const videos = await this.fetchVideos([post.platformPostId]);
      const v = videos.get(post.platformPostId);
      if (!v) return "DELETED"; // indistinguishable from private with an API key
      if (v.status?.privacyStatus === "private") return "PRIVATE";
      return "LIVE";
    } catch {
      return "UNKNOWN";
    }
  }

  /** Resolve "@handle" or a channel id ("UC...") to a channel. 1 quota unit. */
  async resolveChannel(handleOrId: string): Promise<YtChannel | null> {
    const trimmed = handleOrId.trim();
    const params: Record<string, string> = { part: "snippet,statistics" };
    if (/^UC[A-Za-z0-9_-]{22}$/.test(trimmed)) params.id = trimmed;
    else params.forHandle = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    const data = await this.get<{ items?: YtChannel[] }>("channels", params);
    return data.items?.[0] ?? null;
  }

  async verifyAccountOwnership(account: AccountRef): Promise<VerificationResult> {
    if (account.accessToken) {
      const data = await this.get<{ items?: YtChannel[] }>(
        "channels",
        { part: "id", mine: "true" },
        account.accessToken,
      );
      const ids = (data.items ?? []).map((c) => c.id);
      return ids.includes(account.platformAccountId)
        ? { verified: true, method: "OAUTH" }
        : { verified: false, method: "OAUTH", reason: "OAuth account does not own this channel" };
    }
    if (account.verificationCode) {
      const data = await this.get<{ items?: YtChannel[] }>("channels", {
        part: "snippet",
        id: account.platformAccountId,
      });
      const description = data.items?.[0]?.snippet?.description ?? "";
      return description.includes(account.verificationCode)
        ? { verified: true, method: "BIO_CODE" }
        : {
            verified: false,
            method: "BIO_CODE",
            reason: "Verification code not found in the channel description",
          };
    }
    return { verified: false, method: "MANUAL", reason: "No OAuth token or verification code" };
  }

  async fetchAccountProfile(account: AccountRef): Promise<AccountProfile> {
    const data = await this.get<{ items?: YtChannel[] }>("channels", {
      part: "snippet,statistics",
      id: account.platformAccountId,
    });
    const ch = data.items?.[0];
    if (!ch) throw new Error("YouTube channel not found");
    return {
      platformAccountId: ch.id,
      handle: ch.snippet?.customUrl ?? account.handle,
      followerCount: ch.statistics?.hiddenSubscriberCount ? 0 : Number(ch.statistics?.subscriberCount ?? 0),
      accountCreatedAt: ch.snippet?.publishedAt ? new Date(ch.snippet.publishedAt) : null,
      isProfessional: true,
    };
  }
}
