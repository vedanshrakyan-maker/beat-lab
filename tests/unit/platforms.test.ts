import { describe, expect, it, vi } from "vitest";
import { InstagramAdapter } from "@/platforms/instagram";
import { IG_REEL_INSIGHT_METRICS } from "@/platforms/instagram-metrics";
import { MockAdapter, simulatePost } from "@/platforms/mock";
import { MemoryQuotaTracker } from "@/platforms/quota";
import {
  detectPlatform,
  mockScenarioFromUrl,
  parseInstagramUrl,
  parseXUrl,
  parseYouTubeUrl,
} from "@/platforms/urls";
import { parseIsoDuration, YouTubeAdapter } from "@/platforms/youtube";

describe("URL parsing", () => {
  it("parses YouTube Shorts, watch and youtu.be links", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toEqual({
      platformPostId: "dQw4w9WgXcQ",
      isShortsUrl: true,
    });
    expect(parseYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ&t=3")?.platformPostId).toBe(
      "dQw4w9WgXcQ",
    );
    expect(parseYouTubeUrl("youtu.be/dQw4w9WgXcQ")?.platformPostId).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share")?.isShortsUrl).toBe(true);
    expect(parseYouTubeUrl("https://youtube.com/shorts/short")).toBeNull();
    expect(parseYouTubeUrl("https://evil.com/shorts/dQw4w9WgXcQ")).toBeNull();
  });

  it("parses Instagram reel and post links", () => {
    expect(parseInstagramUrl("https://www.instagram.com/reel/C1a2B3c4D5e/")?.platformPostId).toBe(
      "C1a2B3c4D5e",
    );
    expect(parseInstagramUrl("https://instagram.com/someone/reel/C1a2B3c4D5e/?igsh=x")?.platformPostId).toBe(
      "C1a2B3c4D5e",
    );
    expect(parseInstagramUrl("https://www.instagram.com/p/C1a2B3c4D5e")?.platformPostId).toBe("C1a2B3c4D5e");
    expect(parseInstagramUrl("https://www.instagram.com/someone/")).toBeNull();
  });

  it("parses X links (stub platform) and detects platforms", () => {
    expect(parseXUrl("https://x.com/user/status/1234567890123")?.platformPostId).toBe("1234567890123");
    expect(detectPlatform("https://www.instagram.com/reel/C1a2B3c4D5e/")).toBe("INSTAGRAM");
    expect(detectPlatform("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("YOUTUBE");
    expect(detectPlatform("https://tiktok.com/@a/video/1")).toBeNull();
    expect(mockScenarioFromUrl("https://www.instagram.com/reel/ABCDE/?mock=botted_spike")).toBe(
      "BOTTED_SPIKE",
    );
  });
});

describe("MockAdapter", () => {
  it("is deterministic", () => {
    expect(simulatePost("abc", "CLEAN_VIRAL", 10)).toEqual(simulatePost("abc", "CLEAN_VIRAL", 10));
  });

  it("grows fast early then decays (clean viral)", () => {
    const v = [1, 6, 24, 48, 96].map((h) => simulatePost("post1", "CLEAN_VIRAL", h).views);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
    const early = v[2]! - v[0]!; // first day
    const late = v[4]! - v[3]!; // day 3-4
    expect(early).toBeGreaterThan(late * 5);
  });

  it("simulates deletion after lock and view purges", () => {
    expect(simulatePost("p", "DELETED_AFTER_LOCK", 100).existence).toBe("LIVE");
    expect(simulatePost("p", "DELETED_AFTER_LOCK", 300).existence).toBe("DELETED");
    const before = simulatePost("p", "VIEW_DROP", 168).views;
    const after = simulatePost("p", "VIEW_DROP", 336).views;
    expect(after).toBeLessThan(before * 0.7);
  });

  it("drops required tags for MISSING_HASHTAG", () => {
    expect(simulatePost("p", "CLEAN_SLOW", 1, { captionTags: ["#a"] }).caption).toContain("#a");
    expect(simulatePost("p", "MISSING_HASHTAG", 1, { captionTags: ["#a"] }).caption).not.toContain("#a");
  });

  it("reports unavailable insights for small Instagram accounts", async () => {
    const adapter = new MockAdapter("INSTAGRAM", () => new Date("2026-01-02T00:00:00Z"));
    const r = await adapter.fetchPostMetrics([
      {
        platformPostId: "x",
        publishedAt: new Date("2026-01-01T00:00:00Z"),
        mock: { scenario: "INSIGHTS_UNAVAILABLE" },
      },
    ]);
    expect(r.get("x")).toMatchObject({ ok: false, error: "INSIGHTS_UNAVAILABLE" });
  });
});

describe("YouTubeAdapter", () => {
  it("parses ISO-8601 durations", () => {
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT1M5S")).toBe(65);
    expect(parseIsoDuration("PT2H")).toBe(7200);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("garbage")).toBeNull();
  });

  it("batches up to 50 ids per videos.list call and never uses search.list", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      const ids = new URL(url).searchParams.get("id")!.split(",");
      return new Response(
        JSON.stringify({
          items: ids.map((id) => ({
            id,
            snippet: {
              channelId: "UCx",
              title: "t",
              description: "#reelpay",
              publishedAt: "2026-01-01T00:00:00Z",
            },
            statistics: { viewCount: "1234", likeCount: "100", commentCount: "7" },
            status: { privacyStatus: "public" },
            contentDetails: { duration: "PT30S" },
          })),
        }),
      );
    });
    const quota = new MemoryQuotaTracker();
    const yt = new YouTubeAdapter("key", quota, fetchFn as unknown as typeof fetch);
    const posts = Array.from({ length: 120 }, (_, i) => ({
      platformPostId: `vid${String(i).padStart(8, "0")}`,
    }));
    const results = await yt.fetchPostMetrics(posts);
    expect(calls).toHaveLength(3); // 50 + 50 + 20
    expect(calls.every((u) => u.includes("/youtube/v3/videos?") && !u.includes("search"))).toBe(true);
    expect(calls[0]).toContain("part=statistics%2Csnippet%2Cstatus%2CcontentDetails");
    expect(quota.used).toBe(3);
    const first = results.get("vid00000000");
    expect(first).toMatchObject({
      ok: true,
      views: 1234,
      likes: 100,
      comments: 7,
      durationSec: 30,
      isShort: true,
      ownerAccountId: "UCx",
    });
  });

  it("reports missing videos as NOT_FOUND and stops at the quota limit", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ items: [] })));
    const yt = new YouTubeAdapter("key", new MemoryQuotaTracker(0), fetchFn as unknown as typeof fetch);
    const r = await yt.fetchPostMetrics([{ platformPostId: "gone0000000" }]);
    expect(r.get("gone0000000")).toMatchObject({ ok: false, error: "QUOTA_EXCEEDED" });
    expect(fetchFn).not.toHaveBeenCalled();
    const yt2 = new YouTubeAdapter("key", new MemoryQuotaTracker(), fetchFn as unknown as typeof fetch);
    expect(
      (await yt2.fetchPostMetrics([{ platformPostId: "gone0000000" }])).get("gone0000000"),
    ).toMatchObject({ error: "NOT_FOUND" });
  });
});

describe("InstagramAdapter", () => {
  it("requests the views metric (never impressions/plays)", () => {
    expect(IG_REEL_INSIGHT_METRICS).toContain("views");
    expect(IG_REEL_INSIGHT_METRICS).toContain("reach");
    expect(IG_REEL_INSIGHT_METRICS as readonly string[]).not.toContain("impressions");
    expect(IG_REEL_INSIGHT_METRICS as readonly string[]).not.toContain("plays");
  });

  it("maps insights and routes insight errors to INSIGHTS_UNAVAILABLE", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        if (url.includes("media2"))
          return new Response(JSON.stringify({ error: { code: 10, message: "Not enough viewers" } }), {
            status: 400,
          });
        return new Response(
          JSON.stringify({
            data: [
              { name: "views", values: [{ value: 5000 }] },
              { name: "reach", total_value: { value: 3000 } },
              { name: "likes", values: [{ value: 400 }] },
            ],
          }),
        );
      }
      const id = url.includes("media2") ? "media2" : "media1";
      return new Response(
        JSON.stringify({
          id,
          shortcode: "SC",
          caption: "#x",
          owner: { id: "u1" },
          media_product_type: "REELS",
        }),
      );
    });
    const ig = new InstagramAdapter({ apiVersion: "v23.0" }, fetchFn as unknown as typeof fetch);
    const r = await ig.fetchPostMetrics([
      { platformPostId: "A", platformMediaId: "media1", accessToken: "t" },
      { platformPostId: "B", platformMediaId: "media2", accessToken: "t" },
    ]);
    expect(r.get("A")).toMatchObject({ ok: true, views: 5000, reach: 3000, likes: 400, isShort: true });
    expect(r.get("B")).toMatchObject({ ok: false, error: "INSIGHTS_UNAVAILABLE" });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("graph.instagram.com/v23.0/");
  });

  it("maps error 190 to TOKEN_REVOKED", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 190, message: "Session invalidated" } }), {
          status: 401,
        }),
    );
    const ig = new InstagramAdapter({}, fetchFn as unknown as typeof fetch);
    const r = await ig.fetchPostMetrics([{ platformPostId: "A", platformMediaId: "m", accessToken: "t" }]);
    expect(r.get("A")).toMatchObject({ ok: false, error: "TOKEN_REVOKED" });
  });
});
