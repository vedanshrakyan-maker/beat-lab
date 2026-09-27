/**
 * Everything that changes between Instagram Graph API versions lives in THIS file,
 * so an upgrade is a one-file change. See docs/PLATFORMS.md.
 *
 * - `impressions` and `plays` are deprecated for reels in recent versions: do NOT use them.
 * - `views` is the current total-plays metric; `reach` is unique accounts (used by the
 *   VIEWS_TO_REACH_RATIO fraud rule).
 */
export const IG_GRAPH_HOST = "https://graph.instagram.com";
export const IG_OAUTH_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const IG_OAUTH_TOKEN_URL = "https://api.instagram.com/oauth/access_token";

/** Default pinned version; override with IG_GRAPH_API_VERSION. */
export const IG_DEFAULT_API_VERSION = "v23.0";

export const IG_OAUTH_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];

/** Reel insight metrics we request, in the order we request them. */
export const IG_REEL_INSIGHT_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;
export type IgReelMetric = (typeof IG_REEL_INSIGHT_METRICS)[number];

/** Map from Instagram metric name to our MetricSnapshot field. */
export const IG_METRIC_TO_FIELD: Record<
  IgReelMetric,
  "views" | "reach" | "likes" | "comments" | "shares" | "saves"
> = {
  views: "views",
  reach: "reach",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saves",
};

export const IG_MEDIA_FIELDS =
  "id,shortcode,permalink,caption,timestamp,media_type,media_product_type,like_count,comments_count,owner";
export const IG_PROFILE_FIELDS = "user_id,username,account_type,followers_count,media_count";

/** OAuthException codes meaning the token is invalid / revoked / expired. */
export const IG_TOKEN_ERROR_CODES = new Set([190]);
/** Error codes returned when insights are unavailable (small accounts, unsupported media, permissions). */
export const IG_INSIGHTS_UNAVAILABLE_CODES = new Set([10, 100, 200]);
