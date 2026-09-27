import type { DbOrTx } from "@/lib/db";
import { db } from "@/lib/db";
import { getEmailAdapter } from "@/lib/email";
import { t, type MessageKey } from "@/i18n";

export type NotificationKind =
  | "SUBMISSION_APPROVED"
  | "SUBMISSION_REJECTED"
  | "SUBMISSION_UNDER_REVIEW"
  | "BUDGET_LOW"
  | "BUDGET_EXHAUSTED"
  | "EARNINGS_PAYABLE"
  | "PAYOUT_SENT"
  | "PAYOUT_FAILED"
  | "ACCOUNT_FLAGGED"
  | "ACCOUNT_DISCONNECTED"
  | "CAMPAIGN_ACTIVE";

/**
 * In-app notification (always) plus an email via the email adapter. The email is sent by
 * the worker (`notifications.email` job) so a slow mail server never blocks a DB transaction.
 */
export async function notify(
  client: DbOrTx,
  userId: string,
  kind: NotificationKind,
  vars: Record<string, string | number> = {},
  href?: string,
): Promise<void> {
  await client.notification.create({
    data: {
      userId,
      kind,
      title: t(`notify.${kind}.title` as MessageKey, vars),
      body: t(`notify.${kind}.body` as MessageKey, vars),
      href,
    },
  });
}

/** Called by the worker: email every notification not yet emailed. */
export async function flushNotificationEmails(limit = 100): Promise<number> {
  const pending = await db.notification.findMany({
    where: { emailedAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { user: { select: { email: true } } },
  });
  const email = getEmailAdapter();
  for (const n of pending) {
    await email.send({ to: n.user.email, subject: n.title, text: n.body });
    await db.notification.update({ where: { id: n.id }, data: { emailedAt: new Date() } });
  }
  return pending.length;
}
