import { parseInstagramUrl } from "@/platforms/urls";
import {
  IG_DEFAULT_API_VERSION,
  IG_GRAPH_HOST,
  IG_INSIGHTS_UNAVAILABLE_CODES,
  IG_MEDIA_FIELDS,
  IG_METRIC_TO_FIELD,
  IG_OAUTH_AUTHORIZE_URL,
  IG_OAUTH_SCOPES,
  IG_OAUTH_TOKEN_URL,
  IG_PROFILE_FIELDS,
  IG_REEL_INSIGHT_METRICS,
  IG_TOKEN_ERROR_CODES,
  type IgReelMetric,
} from "@/platforms/instagram-metrics";
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
 * Instagram adapter ("Instagram API with Instagram Login").
 *
 * NEEDS META APP REVIEW TO TEST LIVE. Written against the public docs; see docs/PLATFORMS.md.
 *
 * - Personal accounts have NO API access: clippers must connect a professional (Business
 *   or Creator) account via OAuth, which also proves ownership.
 * - Post URLs carry a shortcode; the media id is resolved by listing the account's media.
 * - Insight errors (common for small accounts) return INSIGHTS_UNAVAILABLE so the
 *   submission is routed to the manual-verification queue instead of failing.
 * - Error 190 means the token was revoked/expired: the account is marked DISCONNECTED.
 */

type FetchFn = typeof fetch;

interface IgError {
  error?: { message?: string; code?: number; type?: string };
}

interface IgMedia {
  id: string;
  shortcode?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
  owner?: { id: string };
}

export class InstagramTokenError extends Error {}

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly mode = "live" as const;
  /** Insights are per-media calls; we still group work per account. */
  readonly batchSize = 25;

  constructor(
    private readonly config: { appId?: string; appSecret?: string; apiVersion?: string },
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private get base() {
    return `${IG_GRAPH_HOST}/${this.config.apiVersion ?? IG_DEFAULT_API_VERSION}`;
  }

  parsePostUrl(url: string) {
    return parseInstagramUrl(url);
  }

  private async call<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const res = await this.fetchFn(`${this.base}/${path}?${qs.toString()}`);
    const body = (await res.json().catch(() => ({}))) as T & IgError;
    if (!res.ok || body.error) {
      const code = body.error?.code ?? res.status;
      if (IG_TOKEN_ERROR_CODES.has(code))
        throw new InstagramTokenError(body.error?.message ?? "Token invalid");
      const err = new Error(
        body.error?.message ?? `Instagram ${path} failed (HTTP ${res.status})`,
      ) as Error & { code?: number };
      err.code = code;
      throw err;
    }
    return body;
  }

  /** Find the media id for a shortcode by paging through the account's media (most recent first). */
  async resolveMedia(shortcode: string, token: string, maxPages = 5): Promise<IgMedia | null> {
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { fields: IG_MEDIA_FIELDS, limit: "50" };
      if (after) params.after = after;
      const data = await this.call<{
        data?: IgMedia[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>("me/media", params, token);
      const hit = (data.data ?? []).find(
        (m) => m.shortcode === shortcode || m.permalink?.includes(`/${shortcode}`),
      );
      if (hit) return hit;
      if (!data.paging?.next) return null;
      after = data.paging.cursors?.after;
    }
    return null;
  }

  async fetchPostMetrics(posts: PostRef[]): Promise<Map<string, MetricResult>> {
    const out = new Map<string, MetricResult>();
    for (const post of posts) {
      if (!post.accessToken) {
        out.set(post.platformPostId, { ok: false, error: "TOKEN_REVOKED", message: "Account not connected" });
        continue;
      }
      try {
        const media = post.platformMediaId
          ? await this.call<IgMedia>(post.platformMediaId, { fields: IG_MEDIA_FIELDS }, post.accessToken)
          : await this.resolveMedia(post.platformPostId, post.accessToken);
        if (!media) {
          out.set(post.platformPostId, {
            ok: false,
            error: "NOT_FOUND",
            message: "Reel not found on the connected account",
          });
          continue;
        }
        let insights: Partial<Record<IgReelMetric, number>>;
        try {
          insights = await this.fetchInsights(media.id, post.accessToken);
        } catch (e) {
          if (e instanceof InstagramTokenError) throw e;
          const code = (e as { code?: number }).code;
          if (code !== undefined && IG_INSIGHTS_UNAVAILABLE_CODES.has(code)) {
            out.set(post.platformPostId, {
              ok: false,
              error: "INSIGHTS_UNAVAILABLE",
              message: `Insights unavailable: ${(e as Error).message}`,
            });
            continue;
          }
          throw e;
        }
        out.set(post.platformPostId, {
          ok: true,
          views: insights.views ?? 0,
          reach: insights.reach ?? null,
          likes: insights.likes ?? media.like_count ?? 0,
          comments: insights.comments ?? media.comments_count ?? 0,
          shares: insights.shares ?? 0,
          saves: insights.saved ?? null,
          caption: media.caption ?? null,
          durationSec: null,
          isShort: media.media_product_type === "REELS",
          publishedAt: media.timestamp ? new Date(media.timestamp) : null,
          ownerAccountId: media.owner?.id ?? null,
          platformMediaId: media.id,
          source: "API",
          raw: { media, insights },
        });
      } catch (e) {
        out.set(post.platformPostId, {
          ok: false,
          error: e instanceof InstagramTokenError ? "TOKEN_REVOKED" : "ERROR",
          message: e instanceof Error ? e.message : "Instagram request failed",
        });
      }
    }
    return out;
  }

  async fetchInsights(mediaId: string, token: string): Promise<Partial<Record<IgReelMetric, number>>> {
    const data = await this.call<{
      data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
    }>(`${mediaId}/insights`, { metric: IG_REEL_INSIGHT_METRICS.join(",") }, token);
    const out: Partial<Record<IgReelMetric, number>> = {};
    for (const row of data.data ?? []) {
      if (!(row.name in IG_METRIC_TO_FIELD)) continue;
      const value = row.total_value?.value ?? row.values?.[0]?.value;
      if (typeof value === "number") out[row.name as IgReelMetric] = value;
    }
    return out;
  }

  async fetchPostExists(post: PostRef): Promise<PostExistence> {
    if (!post.accessToken) return "UNKNOWN";
    try {
      if (post.platformMediaId) {
        await this.call<IgMedia>(post.platformMediaId, { fields: "id" }, post.accessToken);
        return "LIVE";
      }
      return (await this.resolveMedia(post.platformPostId, post.accessToken)) ? "LIVE" : "DELETED";
    } catch (e) {
      if (e instanceof InstagramTokenError) return "UNKNOWN";
      const code = (e as { code?: number }).code;
      return code === 100 ? "DELETED" : "UNKNOWN";
    }
  }

  async verifyAccountOwnership(account: AccountRef): Promise<VerificationResult> {
    if (!account.accessToken) {
      return {
        verified: false,
        method: "OAUTH",
        reason: "Instagram requires connecting a professional account via OAuth",
      };
    }
    const me = await this.call<{ user_id?: string; id?: string; account_type?: string }>(
      "me",
      { fields: IG_PROFILE_FIELDS },
      account.accessToken,
    );
    const id = me.user_id ?? me.id;
    if (id !== account.platformAccountId)
      return { verified: false, method: "OAUTH", reason: "Token belongs to a different account" };
    if (me.account_type === "PERSONAL") {
      return {
        verified: false,
        method: "OAUTH",
        reason: "Personal accounts have no API access; switch to Creator or Business",
      };
    }
    return { verified: true, method: "OAUTH" };
  }

  async fetchAccountProfile(account: AccountRef): Promise<AccountProfile> {
    if (!account.accessToken) throw new InstagramTokenError("Account not connected");
    const me = await this.call<{
      user_id?: string;
      id?: string;
      username?: string;
      account_type?: string;
      followers_count?: number;
    }>("me", { fields: IG_PROFILE_FIELDS }, account.accessToken);
    return {
      platformAccountId: me.user_id ?? me.id ?? account.platformAccountId,
      handle: me.username ?? account.handle,
      followerCount: me.followers_count ?? 0,
      accountCreatedAt: null, // not exposed by the API
      isProfessional: me.account_type !== "PERSONAL",
    };
  }

  // --- OAuth helpers (used by /api/oauth/instagram routes) ------------------

  authorizeUrl(redirectUri: string, state: string): string {
    const qs = new URLSearchParams({
      client_id: this.config.appId ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: IG_OAUTH_SCOPES.join(","),
      state,
    });
    return `${IG_OAUTH_AUTHORIZE_URL}?${qs.toString()}`;
  }

  /** Exchange an OAuth code for a long-lived (~60 day) token. */
  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; userId: string; expiresAt: Date }> {
    const form = new URLSearchParams({
      client_id: this.config.appId ?? "",
      client_secret: this.config.appSecret ?? "",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    const shortRes = await this.fetchFn(IG_OAUTH_TOKEN_URL, { method: "POST", body: form });
    const short = (await shortRes.json()) as { access_token?: string; user_id?: string | number } & IgError;
    if (!shortRes.ok || !short.access_token)
      throw new Error(short.error?.message ?? "Instagram code exchange failed");
    const qs = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.config.appSecret ?? "",
      access_token: short.access_token,
    });
    const longRes = await this.fetchFn(`${IG_GRAPH_HOST}/access_token?${qs.toString()}`);
    const long = (await longRes.json()) as { access_token?: string; expires_in?: number } & IgError;
    if (!longRes.ok || !long.access_token)
      throw new Error(long.error?.message ?? "Long-lived token exchange failed");
    return {
      accessToken: long.access_token,
      userId: String(short.user_id),
      expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86400) * 1000),
    };
  }

  /** Refresh a long-lived token (must be at least 24h old and not expired). */
  async refreshToken(token: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const qs = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
    const res = await this.fetchFn(`${IG_GRAPH_HOST}/refresh_access_token?${qs.toString()}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number } & IgError;
    if (!res.ok || !body.access_token) {
      if (body.error?.code !== undefined && IG_TOKEN_ERROR_CODES.has(body.error.code)) {
        throw new InstagramTokenError(body.error.message ?? "Token revoked");
      }
      throw new Error(body.error?.message ?? "Token refresh failed");
    }
    return {
      accessToken: body.access_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 60 * 86400) * 1000),
    };
  }
}
