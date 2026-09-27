import type { Platform } from "@prisma/client";
import { env } from "@/env";
import { InstagramAdapter } from "@/platforms/instagram";
import { MockAdapter } from "@/platforms/mock";
import { DbQuotaTracker } from "@/platforms/quota";
import type { PlatformAdapter } from "@/platforms/types";
import { XAdapter } from "@/platforms/x";
import { YouTubeAdapter } from "@/platforms/youtube";

export interface AdapterOptions {
  /** Clock for the MockAdapter (used by fast-forward / seeding to simulate the past). */
  now?: () => Date;
  /** Share (bps) of the YouTube daily quota at which polling stops. */
  youtubeQuotaStopBps?: number;
}

/** Real implementations are opt-in via env flags; the mock is the default everywhere. */
export function getAdapter(platform: Platform, options: AdapterOptions = {}): PlatformAdapter {
  const e = env();
  if (platform === "YOUTUBE") {
    if (e.YOUTUBE_ADAPTER === "live" && e.YOUTUBE_API_KEY) {
      return new YouTubeAdapter(
        e.YOUTUBE_API_KEY,
        new DbQuotaTracker("youtube", e.YOUTUBE_DAILY_QUOTA, options.youtubeQuotaStopBps ?? 9000),
      );
    }
    return new MockAdapter("YOUTUBE", options.now);
  }
  if (platform === "INSTAGRAM") {
    if (e.INSTAGRAM_ADAPTER === "live") {
      return new InstagramAdapter({
        appId: e.IG_APP_ID,
        appSecret: e.IG_APP_SECRET,
        apiVersion: e.IG_GRAPH_API_VERSION,
      });
    }
    return new MockAdapter("INSTAGRAM", options.now);
  }
  return new XAdapter();
}

export function isMockPlatform(platform: Platform): boolean {
  return getAdapter(platform).mode === "mock";
}

/** Platforms clippers can submit to in v0.1. TikTok is banned in India; Moj/Josh have no API. */
export const SUPPORTED_PLATFORMS: Platform[] = ["INSTAGRAM", "YOUTUBE"];
