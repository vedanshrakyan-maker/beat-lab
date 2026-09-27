import { flushNotificationEmails } from "@/domain/notifications";
import { endExpiredCampaigns, settleCampaigns } from "@/domain/campaigns";
import { lockDueSubmissions, pollDueSnapshots, processHoldEnds } from "@/domain/lifecycle";
import { syncProcessingPayouts } from "@/domain/payouts";
import { refreshExpiringTokens } from "@/domain/social-accounts";
import { recordLedgerVerification } from "@/ledger/verify";

/**
 * Background jobs (pg-boss, Postgres-backed). Each job is a sweep over DB state, so every
 * job is idempotent and safe to retry: per-submission timers live in the database
 * (Submission.nextSnapshotAt / trackingEndsAt / holdEndsAt) and a sweep processes whatever
 * is due, batched per platform. Queues use the "stately" policy so a slow sweep never
 * overlaps itself.
 */
export interface JobDefinition {
  name: string;
  cron: string;
  description: string;
  run: () => Promise<unknown>;
}

export const jobs: JobDefinition[] = [
  {
    name: "metrics-poll",
    cron: "* * * * *",
    description: "Capture due metric snapshots (T+0, 1h, 6h, 24h, daily), batched per platform",
    run: () => pollDueSnapshots(),
  },
  {
    name: "lifecycle-lock",
    cron: "* * * * *",
    description: "Lock submissions whose tracking window ended",
    run: () => lockDueSubmissions(),
  },
  {
    name: "lifecycle-hold-end",
    cron: "*/5 * * * *",
    description: "Re-check held submissions and clear clean ones to PAYABLE",
    run: () => processHoldEnds(),
  },
  {
    name: "campaigns-sweep",
    cron: "*/5 * * * *",
    description: "End campaigns past their end date; settle finished campaigns",
    run: async () => ({ ended: await endExpiredCampaigns(), settled: await settleCampaigns() }),
  },
  {
    name: "payouts-sync",
    cron: "*/2 * * * *",
    description: "Poll the payment provider for payouts still processing",
    run: () => syncProcessingPayouts(),
  },
  {
    name: "notifications-email",
    cron: "* * * * *",
    description: "Email in-app notifications via the email adapter",
    run: () => flushNotificationEmails(),
  },
  {
    name: "tokens-refresh",
    cron: "17 3 * * *",
    description: "Refresh Instagram long-lived tokens; disconnect revoked accounts",
    run: () => refreshExpiringTokens(),
  },
  {
    name: "ledger-verify",
    cron: "7 2 * * *",
    description: "Ledger integrity check (result shown on the admin health panel)",
    run: async () => (await recordLedgerVerification()).ok,
  },
];
