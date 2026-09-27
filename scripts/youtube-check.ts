/**
 * npm run youtube:check -- <shorts url or video id> [...]
 * Calls the LIVE YouTube Data API v3 (videos.list, 1 quota unit per 50 ids) with
 * YOUTUBE_API_KEY and prints normalized metrics. Use it to confirm the adapter works
 * against real public Shorts before switching YOUTUBE_ADAPTER=live.
 */
import { MemoryQuotaTracker } from "@/platforms/quota";
import { parseYouTubeUrl } from "@/platforms/urls";
import { YouTubeAdapter } from "@/platforms/youtube";

async function main() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error("Set YOUTUBE_API_KEY (a YouTube Data API v3 key) first.");
    process.exit(1);
  }
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("Usage: npm run youtube:check -- https://www.youtube.com/shorts/<id> [...]");
    process.exit(1);
  }
  const ids = inputs.map((i) => parseYouTubeUrl(i)?.platformPostId ?? i);
  const quota = new MemoryQuotaTracker();
  const yt = new YouTubeAdapter(key, quota);
  const results = await yt.fetchPostMetrics(ids.map((platformPostId) => ({ platformPostId })));
  for (const id of ids) {
    const r = results.get(id);
    if (!r?.ok) {
      console.log(`${id}: ${r?.error} — ${r?.message}`);
      continue;
    }
    console.log(
      `${id}: ${r.views.toLocaleString("en-IN")} views, ${r.likes.toLocaleString("en-IN")} likes, ${r.comments.toLocaleString("en-IN")} comments, ` +
        `${r.durationSec}s (${r.isShort ? "Short" : "not a Short"}), channel ${r.ownerAccountId}, published ${r.publishedAt?.toISOString()}`,
    );
  }
  console.log(`Quota used: ${quota.used} unit(s)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
