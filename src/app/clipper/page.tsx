import Link from "next/link";
import { PageHeader, Section } from "@/components/page";
import { SubmissionStatusBadge } from "@/components/status";
import { Card, Stat } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { walletSummary } from "@/domain/payouts";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { requirePageUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clipper" };

export default async function ClipperHome() {
  const user = await requirePageUser("CLIPPER");
  const [accounts, profile, wallet, recent, joined] = await Promise.all([
    db.socialAccount.count({ where: { userId: user.id, status: "VERIFIED" } }),
    db.payoutProfile.findUnique({ where: { userId: user.id } }),
    walletSummary(user.id),
    db.submission.findMany({
      where: { clipperId: user.id },
      orderBy: { submittedAt: "desc" },
      take: 5,
      include: { campaign: { select: { title: true } } },
    }),
    db.campaignParticipation.count({ where: { clipperId: user.id, status: "ACTIVE" } }),
  ]);
  const steps = [
    { done: accounts > 0, label: "Connect Instagram or YouTube", href: "/clipper/accounts" },
    { done: !!profile, label: "Add UPI ID and PAN for payouts", href: "/clipper/accounts#payout" },
    { done: joined > 0, label: "Join a campaign", href: "/campaigns" },
    { done: recent.length > 0, label: "Submit your first post", href: "/campaigns" },
  ];
  return (
    <div>
      <PageHeader
        eyebrow="Clipper"
        title={`Hi ${user.name?.split(" ")[0] ?? "there"}`}
        actions={<LinkButton href="/campaigns">Find campaigns</LinkButton>}
      />
      {user.flaggedAt ? (
        <Card className="border-bad/40 bg-bad/5 text-bad mb-6 text-sm">
          Your account is under review: {user.flagReason}. Withdrawals are paused.
        </Card>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Ready to withdraw" value={formatINR(wallet.payablePaise)} accent />
        <Stat label="Pending (tracking & hold)" value={formatINR(wallet.pendingPaise)} />
        <Stat
          label="Paid out"
          value={formatINR(wallet.paidOutNetPaise)}
          hint={`TDS withheld ${formatINR(wallet.tdsWithheldPaise)}`}
        />
      </div>
      {steps.some((s) => !s.done) ? (
        <Section title="Get set up">
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={s.label}>
                <Link
                  href={s.href}
                  className="border-border bg-surface hover:border-fg/30 flex items-center gap-3 rounded-xl border px-4 py-3"
                >
                  <span className={s.done ? "text-good" : "text-muted"}>{s.done ? "✓" : String(i + 1)}</span>
                  <span className={s.done ? "text-muted line-through" : ""}>{s.label}</span>
                </Link>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      <Section
        title="Recent submissions"
        actions={
          <Link href="/clipper/submissions" className="text-muted hover:text-fg text-sm">
            All →
          </Link>
        }
      >
        <div className="space-y-2">
          {recent.map((s) => (
            <Link
              key={s.id}
              href={`/clipper/submissions/${s.id}`}
              className="border-border bg-surface hover:border-fg/30 flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
            >
              <span className="truncate">{s.campaign.title}</span>
              <span className="flex items-center gap-3">
                <span className="tabular text-muted text-sm">{formatINR(s.earnedPaise)}</span>
                <SubmissionStatusBadge status={s.status} />
              </span>
            </Link>
          ))}
          {recent.length === 0 ? <p className="text-muted text-sm">Nothing yet.</p> : null}
        </div>
      </Section>
    </div>
  );
}
