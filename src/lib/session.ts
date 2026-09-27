import "server-only";
import type { Role, User } from "@prisma/client";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { userActor, type Actor } from "@/lib/audit";
import { fingerprintHash } from "@/lib/crypto";
import { db } from "@/lib/db";

/**
 * Server-side RBAC. Never trust the client: every page and server action loads the user
 * from the database and checks roles and status here.
 */

export class AuthError extends Error {}

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({ where: { id } });
  if (!user || user.status === "BANNED") return null;
  return user;
});

/** For pages: redirect to sign-in when anonymous, or home when the role is missing. */
export async function requirePageUser(role?: Role): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (role && !user.roles.includes(role)) redirect("/?forbidden=1");
  return user;
}

/** For server actions / route handlers: throws instead of redirecting. */
export async function requireUser(role?: Role): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Please sign in");
  if (user.status !== "ACTIVE") throw new AuthError("Your account is not active");
  if (role && !user.roles.includes(role)) throw new AuthError("You don't have access to this");
  return user;
}

export async function requireOrgMember(userId: string, organizationId: string, isAdmin = false) {
  if (isAdmin) return;
  const m = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!m) throw new AuthError("You are not a member of this organization");
}

export async function clientIpHash(): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return ip ? fingerprintHash(ip) : null;
}

/** Audit actor for the current request (IP stored hashed only). */
export async function actorFor(user: User): Promise<Actor> {
  return userActor(user.id, await clientIpHash());
}

/** Record a hashed device fingerprint for multi-account detection. */
export async function recordFingerprint(userId: string): Promise<void> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const ua = h.get("user-agent") ?? "unknown";
  const ipHash = fingerprintHash(ip);
  const userAgentHash = fingerprintHash(ua);
  await db.deviceFingerprint.upsert({
    where: { userId_ipHash_userAgentHash: { userId, ipHash, userAgentHash } },
    create: { userId, ipHash, userAgentHash },
    update: { lastSeen: new Date() },
  });
}
