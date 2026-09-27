import type { Platform, SocialAccount } from "@prisma/client";
import { z } from "zod";
import { audit, systemActor, type Actor } from "@/lib/audit";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { env } from "@/env";
import { getAdapter } from "@/platforms";
import { InstagramAdapter, InstagramTokenError } from "@/platforms/instagram";
import { YouTubeAdapter } from "@/platforms/youtube";
import { disconnectAccount } from "@/domain/lifecycle";

export class SocialAccountError extends Error {}

export const handleSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .transform((h) => h.replace(/^@/, ""))
  .refine((h) => /^[\w.-]+$/.test(h), "Handles contain letters, numbers, . _ and - only");

function assertConnectable(platform: Platform) {
  if (platform === "X") throw new SocialAccountError("X is not supported yet");
}

async function ensureNotClaimed(platform: Platform, platformAccountId: string, userId: string) {
  const existing = await db.socialAccount.findUnique({
    where: { platform_platformAccountId: { platform, platformAccountId } },
  });
  if (existing && existing.userId !== userId) {
    throw new SocialAccountError("This account is already connected to another ReelPay user");
  }
  return existing;
}

/**
 * Development "OAuth": with the MockAdapter active, connecting is instant and verified.
 * With live adapters, Instagram must use real OAuth and YouTube OAuth or the bio code.
 */
export async function connectMockAccount(
  userId: string,
  platform: Platform,
  rawHandle: string,
  actor: Actor,
  options: { followerCount?: number; accountCreatedAt?: Date | null } = {},
): Promise<SocialAccount> {
  assertConnectable(platform);
  const adapter = getAdapter(platform);
  if (adapter.mode !== "mock")
    throw new SocialAccountError("Mock connection is only available with the mock adapter");
  const handle = handleSchema.parse(rawHandle);
  const platformAccountId = `mock_${platform.toLowerCase()}_${handle.toLowerCase()}`;
  await ensureNotClaimed(platform, platformAccountId, userId);
  const ref = { platformAccountId, handle, mock: options };
  const verification = await adapter.verifyAccountOwnership(ref);
  const profile = await adapter.fetchAccountProfile(ref);
  return db.$transaction(async (tx) => {
    const account = await tx.socialAccount.upsert({
      where: { platform_platformAccountId: { platform, platformAccountId } },
      create: {
        userId,
        platform,
        platformAccountId,
        handle,
        followerCount: profile.followerCount,
        accountCreatedAt: profile.accountCreatedAt,
        verificationMethod: "OAUTH",
        verifiedAt: verification.verified ? new Date() : null,
        encryptedAccessToken: encrypt(`mock-token-${randomToken(8)}`),
        tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
        status: verification.verified ? "VERIFIED" : "PENDING_VERIFICATION",
      },
      update: {
        status: verification.verified ? "VERIFIED" : "PENDING_VERIFICATION",
        followerCount: profile.followerCount,
      },
    });
    await audit(tx, actor, "social_account.connect", "SocialAccount", account.id, undefined, {
      platform,
      handle,
      method: "OAUTH(mock)",
      verified: verification.verified,
    });
    return account;
  });
}

/** YouTube fallback: the clipper puts a code in their channel description; we read it via the API. */
export async function startBioVerification(
  userId: string,
  platform: Platform,
  handleOrChannelId: string,
  actor: Actor,
) {
  assertConnectable(platform);
  if (platform !== "YOUTUBE")
    throw new SocialAccountError("Instagram accounts connect via OAuth (professional accounts only)");
  const code = `REELPAY-${randomToken(3).toUpperCase()}`;
  const adapter = getAdapter("YOUTUBE");
  let platformAccountId: string;
  let handle: string;
  if (adapter instanceof YouTubeAdapter) {
    const channel = await adapter.resolveChannel(handleOrChannelId);
    if (!channel) throw new SocialAccountError("YouTube channel not found");
    platformAccountId = channel.id;
    handle = channel.snippet?.customUrl ?? handleOrChannelId;
  } else {
    handle = handleSchema.parse(handleOrChannelId);
    platformAccountId = `mock_youtube_${handle.toLowerCase()}`;
  }
  await ensureNotClaimed("YOUTUBE", platformAccountId, userId);
  return db.$transaction(async (tx) => {
    const account = await tx.socialAccount.upsert({
      where: { platform_platformAccountId: { platform: "YOUTUBE", platformAccountId } },
      create: {
        userId,
        platform: "YOUTUBE",
        platformAccountId,
        handle: handle.replace(/^@/, ""),
        verificationMethod: "BIO_CODE",
        verificationCode: code,
      },
      update: { verificationCode: code, verificationMethod: "BIO_CODE" },
    });
    await audit(tx, actor, "social_account.bio_code_issued", "SocialAccount", account.id, undefined, {
      platform,
      handle,
    });
    return account;
  });
}

export async function checkBioVerification(
  accountId: string,
  userId: string,
  actor: Actor,
): Promise<SocialAccount> {
  const account = await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (account.userId !== userId) throw new SocialAccountError("Not your account");
  const adapter = getAdapter(account.platform);
  const ref = {
    platformAccountId: account.platformAccountId,
    handle: account.handle,
    verificationCode: account.verificationCode,
  };
  const result = await adapter.verifyAccountOwnership(ref);
  if (!result.verified) throw new SocialAccountError(result.reason ?? "Verification code not found yet");
  const profile = await adapter.fetchAccountProfile(ref);
  return db.$transaction(async (tx) => {
    const updated = await tx.socialAccount.update({
      where: { id: account.id },
      data: {
        status: "VERIFIED",
        verifiedAt: new Date(),
        followerCount: profile.followerCount,
        accountCreatedAt: profile.accountCreatedAt,
      },
    });
    await audit(
      tx,
      actor,
      "social_account.verified",
      "SocialAccount",
      account.id,
      { status: account.status },
      { status: "VERIFIED", method: result.method },
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Instagram OAuth (live) — needs Meta app review to use with real accounts.
// ---------------------------------------------------------------------------

export function instagramAdapterLive(): InstagramAdapter {
  const e = env();
  return new InstagramAdapter({
    appId: e.IG_APP_ID,
    appSecret: e.IG_APP_SECRET,
    apiVersion: e.IG_GRAPH_API_VERSION,
  });
}

export function instagramRedirectUri(): string {
  return `${env().APP_URL}/api/oauth/instagram/callback`;
}

export async function completeInstagramOAuth(
  userId: string,
  code: string,
  actor: Actor,
): Promise<SocialAccount> {
  const ig = instagramAdapterLive();
  const token = await ig.exchangeCode(code, instagramRedirectUri());
  const ref = { platformAccountId: token.userId, handle: "", accessToken: token.accessToken };
  const verification = await ig.verifyAccountOwnership(ref);
  if (!verification.verified)
    throw new SocialAccountError(verification.reason ?? "Could not verify the Instagram account");
  const profile = await ig.fetchAccountProfile(ref);
  await ensureNotClaimed("INSTAGRAM", profile.platformAccountId, userId);
  return db.$transaction(async (tx) => {
    const data = {
      handle: profile.handle,
      followerCount: profile.followerCount,
      isProfessional: profile.isProfessional,
      verificationMethod: "OAUTH" as const,
      verifiedAt: new Date(),
      encryptedAccessToken: encrypt(token.accessToken),
      tokenExpiresAt: token.expiresAt,
      status: "VERIFIED" as const,
    };
    const account = await tx.socialAccount.upsert({
      where: {
        platform_platformAccountId: { platform: "INSTAGRAM", platformAccountId: profile.platformAccountId },
      },
      create: { userId, platform: "INSTAGRAM", platformAccountId: profile.platformAccountId, ...data },
      update: data,
    });
    await audit(tx, actor, "social_account.connect", "SocialAccount", account.id, undefined, {
      platform: "INSTAGRAM",
      handle: profile.handle,
      method: "OAUTH",
    });
    return account;
  });
}

/** Worker job: refresh Instagram long-lived tokens expiring within 7 days; disconnect revoked ones. */
export async function refreshExpiringTokens(
  now = new Date(),
): Promise<{ refreshed: number; disconnected: number }> {
  if (getAdapter("INSTAGRAM").mode === "mock") return { refreshed: 0, disconnected: 0 };
  const ig = instagramAdapterLive();
  const soon = new Date(now.getTime() + 7 * 86_400_000);
  const accounts = await db.socialAccount.findMany({
    where: {
      platform: "INSTAGRAM",
      status: "VERIFIED",
      tokenExpiresAt: { lte: soon },
      encryptedAccessToken: { not: null },
    },
  });
  let refreshed = 0;
  let disconnected = 0;
  for (const a of accounts) {
    try {
      const t = await ig.refreshToken(decrypt(a.encryptedAccessToken!));
      await db.socialAccount.update({
        where: { id: a.id },
        data: { encryptedAccessToken: encrypt(t.accessToken), tokenExpiresAt: t.expiresAt },
      });
      refreshed++;
    } catch (e) {
      if (e instanceof InstagramTokenError || (a.tokenExpiresAt && a.tokenExpiresAt <= now)) {
        await db.$transaction((tx) =>
          disconnectAccount(tx, a.id, e instanceof Error ? e.message : "Token refresh failed"),
        );
        disconnected++;
      }
    }
  }
  if (refreshed + disconnected > 0) {
    await db.$transaction((tx) =>
      audit(tx, systemActor, "social_account.token_refresh", "SocialAccount", "batch", undefined, {
        refreshed,
        disconnected,
      }),
    );
  }
  return { refreshed, disconnected };
}
