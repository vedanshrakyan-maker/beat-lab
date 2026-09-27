import { env } from "@/env";

/** Google OAuth for YouTube ownership (scope youtube.readonly). Live mode only. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export function googleRedirectUri() {
  return `${env().APP_URL}/api/oauth/youtube/callback`;
}

export function googleAuthorizeUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: env().GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${qs.toString()}`;
}

export async function exchangeGoogleCode(code: string, fetchFn: typeof fetch = fetch) {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: env().GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env().GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token) throw new Error(body.error ?? "Google token exchange failed");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
  };
}
