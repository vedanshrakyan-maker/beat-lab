# Platforms

In scope: **Instagram Reels** and **YouTube Shorts**. **X** has a stub adapter (URL parsing only).
**TikTok** is excluded (banned in India). **Moj/Josh** have no usable public API. No platform is
ever scraped — official APIs or the manual fallback only.

Every adapter implements `PlatformAdapter` (src/platforms/types.ts). The **MockAdapter** is the
default everywhere; real adapters are enabled per platform with env flags.

## MockAdapter (default)

Deterministic: metrics are a pure function of `(post id, scenario, hours since posting)`, with
realistic curves (fast growth in the first 24–48h, then decay). Scenarios: `CLEAN_VIRAL`,
`CLEAN_SLOW`, `SMALL_ACCOUNT_VIRAL`, `BOTTED_SPIKE`, `DELETED_AFTER_LOCK`, `PLATEAU_AT_CAP`,
`LOW_ENGAGEMENT`, `LOOPING`, `VIEW_DROP`, `MISSING_HASHTAG`, `MULTI_ACCOUNT`,
`INSIGHTS_UNAVAILABLE`. Pick one per submission with `?mock=<scenario>` on the post URL or the
dev-only scenario dropdown; otherwise a clean scenario is derived from the post id.

## YouTube (`YOUTUBE_ADAPTER=live`)

What it does

- `videos.list?part=statistics,snippet,status,contentDetails&id=<up to 50 ids>` — **1 quota unit per
  call**, batched. `search.list` (100 units) is never used.
- Views = public `statistics.viewCount`; likes/comments from `statistics`; `reach` is not
  available (the reach fraud rule simply doesn't apply).
- Shorts: duration ≤ 180s (from `contentDetails.duration`) or a `/shorts/` URL.
- Caption for the required-tag check = title + description + tags.
- Deleted/private videos are absent from results → `NOT_FOUND` → the lock/hold re-check treats them
  as deleted.
- Ownership: OAuth `channels.list?mine=true` (route `/api/oauth/youtube/*`, scope
  `youtube.readonly`) or the **bio code**: we issue `REELPAY-XXXXXX`, the clipper pastes it into the
  channel description, we read it with `channels.list?part=snippet`.
- Quota: every call is recorded in `ApiQuotaUsage` per Pacific-time day (quota resets at midnight
  PT). Polling stops at `youtubeQuotaStopBps` (default 90%) of `YOUTUBE_DAILY_QUOTA`, records a
  `QUOTA_ALERT` shown on the admin health panel, and resumes the next day.

Go live

1. Google Cloud console → create a project → enable **YouTube Data API v3** → create an **API key**
   (restrict it to the YouTube Data API and your server IPs).
2. Set `YOUTUBE_API_KEY`, `YOUTUBE_ADAPTER=live`, `YOUTUBE_DAILY_QUOTA` (default project quota is
   10,000 units/day; one poll of 50 videos costs 1 unit, so 10k units ≈ 500k video-polls/day).
3. Check against real public Shorts: `npm run youtube:check -- https://www.youtube.com/shorts/<id>`.
4. Optional OAuth: create an OAuth client (web), add
   `{APP_URL}/api/oauth/youtube/callback` as a redirect URI, set `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
   Using sensitive scopes with real users requires Google's OAuth verification.
5. If you outgrow the quota: apply for a quota extension (YouTube API Services audit).

## Instagram (`INSTAGRAM_ADAPTER=live`) — needs Meta app review to test live

What it does ("Instagram API with Instagram Login", graph.instagram.com)

- **Personal accounts have no API access.** Clippers connect a professional (Creator/Business)
  account via OAuth (`/api/oauth/instagram/start`), which also proves ownership. Scopes:
  `instagram_business_basic`, `instagram_business_manage_insights`.
- Post URLs carry a shortcode; the media id is resolved by paging `me/media` and cached on the
  submission.
- Insights: `/{media-id}/insights?metric=views,reach,likes,comments,shares,saved`.
  `impressions` and `plays` are deprecated and **not used**. `reach` powers the views/reach rule.
- Insight errors (reportedly common for accounts under ~1,000 followers) → `INSIGHTS_UNAVAILABLE`
  → the submission goes to the **manual verification queue** instead of failing.
- Error 190 → token revoked/expired → account `DISCONNECTED`, clipper notified.
- Long-lived tokens (~60 days) are refreshed daily when they expire within 7 days
  (`tokens-refresh` job).
- The Graph API version is pinned (`IG_GRAPH_API_VERSION`, default `v23.0`); every
  version-specific metric name lives in `src/platforms/instagram-metrics.ts`, so an upgrade is a
  one-file change.

Go live

1. developers.facebook.com → create an app → add the **Instagram** product ("API setup with
   Instagram login").
2. Add `{APP_URL}/api/oauth/instagram/callback` as a valid OAuth redirect URI; set `IG_APP_ID`,
   `IG_APP_SECRET`, `INSTAGRAM_ADAPTER=live`.
3. While in development mode only app roles/testers can connect. For real clippers submit
   **App Review** for `instagram_business_basic` and `instagram_business_manage_insights` (screen
   recording of the flow, privacy policy, data deletion URL) and complete **Business Verification**.
4. Verify on a test professional account: connect → submit a reel → watch snapshots arrive.

## Manual verification fallback (Section 6.4)

When API metrics are unavailable the clipper uploads a screen recording of their in-app insights
(MP4/MOV/WebM/PNG/JPEG, ≤50 MB, stored under `./uploads` in v0.1 — move to S3/GCS with signed URLs
for production). An admin reviews it (Admin → review item → Manual metrics) and enters the numbers.
Manual snapshots are stored with `source = MANUAL` and the admin's id, and the fraud engine uses
**stricter bands** for them. This keeps the pilot usable before Meta app review is approved.

## Polling schedule

T+0 (at submission), T+1h, T+6h, T+24h, then every 24h until `trackingWindowDays` ends (default 7),
then LOCK → HOLD (`holdPeriodDays`, default 7) → re-check → PAYABLE. Offsets are configurable in
the `polling` setting.

## Payments (Razorpay) — skeleton

- `PAYMENTS_PROVIDER=razorpay` with **test keys** (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
- Funding: Razorpay **Orders** + Checkout. Offer **UPI Intent / QR**, not UPI Collect (being
  deprecated by NPCI). The client-side Checkout widget is not wired in v0.1 (the mock checkout
  page is); wiring it is a small `app/checkout` change.
- Webhooks: `POST /api/webhooks/payments/razorpay`, verified with `X-Razorpay-Signature`
  (HMAC-SHA256 of the raw body with `RAZORPAY_WEBHOOK_SECRET`), de-duplicated by
  `X-Razorpay-Event-Id`. Subscribe to `order.paid`, `payment.failed`, `payout.*`.
- Payouts: **RazorpayX** contact → fund account (VPA) → payout with `X-Payout-Idempotency`
  (the payout's `idempotencyKey`), `mode: UPI`, from `RAZORPAYX_ACCOUNT_NUMBER`.
- Needs a RazorpayX current account and KYC; confirm the custody model first (COMPLIANCE.md).
