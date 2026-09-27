import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, Stat } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { env } from "@/env";
import { jobs } from "@/jobs/queues";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { acct, balances } from "@/ledger/ledger";
import type { CheckResult } from "@/ledger/verify";
import { getPaymentProvider } from "@/payments";
import { getAdapter } from "@/platforms";
import { pacificDay } from "@/platforms/quota";
import { formatDate, timeAgo } from "@/lib/utils";
import { verifyLedgerAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

async function jobStats(): Promise<Map<string, Record<string, number>> | null> {
  try {
    const rows = await db.$queryRaw<{ name: string; state: string; n: bigint }[]>`
      SELECT name, state::text AS state, COUNT(*)::bigint AS n FROM pgboss.job GROUP BY name, state`;
    const map = new Map<string, Record<string, number>>();
    for (const r of rows) map.set(r.name, { ...(map.get(r.name) ?? {}), [r.state]: Number(r.n) });
    return map;
  } catch {
    return null; // worker has never run (pg-boss schema missing)
  }
}

async function lastRuns(): Promise<Map<string, Date>> {
  try {
    const rows = await db.$queryRaw<{ name: string; at: Date }[]>`
      SELECT name, MAX(completed_on) AS at FROM pgboss.job WHERE state = 'completed' GROUP BY name`;
    return new Map(rows.filter((r) => r.at).map((r) => [r.name, r.at]));
  } catch {
    return new Map();
  }
}

export default async function AdminHome() {
  const [queue, flagged, pendingPayouts, ledgerCheck, quotaAlert, quota, stats, runs, sys] =
    await Promise.all([
      db.submission.count({
        where: {
          OR: [
            { status: "FLAGGED" },
            { reviewState: "NEEDS_REVIEW", status: { notIn: ["REJECTED", "VOIDED", "CLAWED_BACK"] } },
          ],
        },
      }),
      db.user.count({ where: { flaggedAt: { not: null } } }),
      db.payout.count({ where: { status: "PENDING" } }),
      db.healthCheck.findFirst({ where: { kind: "LEDGER_VERIFY" }, orderBy: { createdAt: "desc" } }),
      db.healthCheck.findFirst({
        where: { kind: "QUOTA_ALERT", createdAt: { gte: new Date(new Date().getTime() - 86_400_000) } },
        orderBy: { createdAt: "desc" },
      }),
      db.apiQuotaUsage.findMany({ where: { day: pacificDay() } }),
      jobStats(),
      lastRuns(),
      balances(db, [
        acct.funderCashIn(),
        acct.platformFeeRevenue(),
        acct.gstPayable(),
        acct.tdsPayable(),
        acct.payoutClearing(),
      ]),
    ]);
  const e = env();
  const checks = (ledgerCheck?.details ?? []) as unknown as CheckResult[];
  const ytUsed = quota.find((q) => q.provider === "youtube")?.units ?? 0;

  return (
    <div>
      <PageHeader eyebrow="Admin" title="Operations" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/admin/review">
          <Stat label="Needs review" value={queue} accent={queue > 0} />
        </Link>
        <Link href="/admin/payouts">
          <Stat label="Withdrawals pending" value={pendingPayouts} />
        </Link>
        <Stat label="Flagged users" value={flagged} />
        <Stat
          label="Cash held"
          value={formatINR(sys.get(acct.funderCashIn()) ?? 0n)}
          hint={`fee revenue ${formatINR(sys.get(acct.platformFeeRevenue()) ?? 0n)}`}
        />
      </div>

      <Section title="Health">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Ledger verification</h3>
              {ledgerCheck ? (
                <Badge tone={ledgerCheck.ok ? "good" : "bad"}>{ledgerCheck.ok ? "passing" : "FAILING"}</Badge>
              ) : (
                <Badge>never run</Badge>
              )}
            </div>
            <p className="text-muted mt-1 text-xs">
              {ledgerCheck ? `Last run ${timeAgo(ledgerCheck.createdAt)}` : "Runs daily in the worker."}
            </p>
            <ul className="mt-3 space-y-1 text-xs">
              {checks.map((c) => (
                <li key={c.name} className={c.ok ? "text-muted" : "text-bad"}>
                  {c.ok ? "✓" : "✗"} {c.name}
                  {!c.ok ? <div className="pl-4">{c.details.slice(0, 3).join("; ")}</div> : null}
                </li>
              ))}
            </ul>
            <ActionForm action={verifyLedgerAction} className="mt-3">
              <SubmitButton size="sm" variant="secondary">
                Run now
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <h3 className="font-medium">Integrations</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Instagram</dt>
                <dd>
                  <Badge tone={getAdapter("INSTAGRAM").mode === "mock" ? "warn" : "good"}>
                    {getAdapter("INSTAGRAM").mode} · {e.IG_GRAPH_API_VERSION}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">YouTube</dt>
                <dd>
                  <Badge tone={getAdapter("YOUTUBE").mode === "mock" ? "warn" : "good"}>
                    {getAdapter("YOUTUBE").mode}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Payments</dt>
                <dd>
                  <Badge tone={getPaymentProvider().name === "mock" ? "warn" : "good"}>
                    {getPaymentProvider().name}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Email</dt>
                <dd>
                  <Badge>{e.EMAIL_PROVIDER}</Badge>
                </dd>
              </div>
            </dl>
            <h3 className="mt-5 font-medium">API quota today (PT)</h3>
            <div className="mt-2 text-sm">
              YouTube: <span className="tabular">{ytUsed.toLocaleString("en-IN")}</span> /{" "}
              {e.YOUTUBE_DAILY_QUOTA.toLocaleString("en-IN")} units
            </div>
            {quotaAlert ? (
              <p className="text-bad mt-2 text-xs">
                Quota alert {timeAgo(quotaAlert.createdAt)} — polling paused until reset.
              </p>
            ) : null}
          </Card>
          <Card>
            <h3 className="font-medium">System balances</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">GST payable</dt>
                <dd className="tabular">{formatINR(sys.get(acct.gstPayable()) ?? 0n)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">TDS payable</dt>
                <dd className="tabular">{formatINR(sys.get(acct.tdsPayable()) ?? 0n)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Payout clearing</dt>
                <dd className="tabular">{formatINR(sys.get(acct.payoutClearing()) ?? 0n)}</dd>
              </div>
            </dl>
            <a
              href={`/admin/tax/statement?fy=${new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1}`}
              className="text-accent mt-4 inline-block text-sm underline"
            >
              Download annual TDS statement (CSV)
            </a>
          </Card>
        </div>
      </Section>

      <Section title="Job queues">
        {!stats ? (
          <p className="text-warn mb-3 text-sm">
            The worker hasn&apos;t started yet. Run <code>npm run worker</code>.
          </p>
        ) : null}
        <Table>
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>Schedule</Th>
              <Th>Last completed</Th>
              <Th className="text-right">Queued</Th>
              <Th className="text-right">Active</Th>
              <Th className="text-right">Failed</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const s = stats?.get(j.name) ?? {};
              return (
                <tr key={j.name}>
                  <Td>
                    <div className="font-mono text-xs">{j.name}</div>
                    <div className="text-muted text-xs">{j.description}</div>
                  </Td>
                  <Td className="font-mono text-xs">{j.cron}</Td>
                  <Td className="text-muted text-xs">
                    {runs.get(j.name) ? formatDate(runs.get(j.name)!, true) : "—"}
                  </Td>
                  <Td className="tabular text-right">{(s.created ?? 0) + (s.retry ?? 0)}</Td>
                  <Td className="tabular text-right">{s.active ?? 0}</Td>
                  <Td className={`tabular text-right ${s.failed ? "text-bad" : ""}`}>{s.failed ?? 0}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>
    </div>
  );
}
