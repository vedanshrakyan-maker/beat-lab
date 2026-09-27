import type { Prisma } from "@prisma/client";
import { db, type DbOrTx } from "@/lib/db";
import { jsonSafe } from "@/lib/money";

export interface Actor {
  /** User id, or null for system/webhook actors. */
  id: string | null;
  /** "user", "system", "webhook:mock", ... */
  label: string;
  ipHash?: string | null;
}

export const systemActor: Actor = { id: null, label: "system" };

export function userActor(userId: string, ipHash?: string | null): Actor {
  return { id: userId, label: "user", ipHash };
}

/**
 * Append-only audit trail for every admin action and every state change on
 * submissions, campaigns and payouts. Call inside the same transaction as the change.
 */
export async function audit(
  client: DbOrTx,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: actor.id,
      actorLabel: actor.label,
      action,
      entityType,
      entityId,
      before: before === undefined ? undefined : (jsonSafe(before) as Prisma.InputJsonValue),
      after: after === undefined ? undefined : (jsonSafe(after) as Prisma.InputJsonValue),
      ipHash: actor.ipHash ?? null,
    },
  });
}

export async function recentAudit(limit = 100, filter?: { entityType?: string; entityId?: string }) {
  return db.auditLog.findMany({
    where: { entityType: filter?.entityType, entityId: filter?.entityId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { email: true, name: true } } },
  });
}
