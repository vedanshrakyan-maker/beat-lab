import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { CampaignStatusBadge, PlatformBadge, SubmissionStatusBadge } from "@/components/status";
import { Card, Stat } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { ViewsChart } from "@/components/views-chart";
import { campaignAnalytics } from "@/domain/analytics";
import { db } from "@/lib/db";
import { formatINR, formatINRCompact, formatViewsIndian, fundingBreakdown } from "@/lib/money";
import { requireOrgMember, requirePageUser } from "@/lib/session";
import { campaignControlAction, fundAction } from "../../actions";

export const dynamic = "force-dynamic";

const RULE_LABELS: Record<string, string> = {
  VELOCITY_SPIKE: "Bought-view spikes",
  LOW_ENGAGEMENT_RATIO: "Views without engagement",
  VIEWS_TO_REACH_RATIO: "Looping / replay bots",
  SMALL_ACCOUNT_OUTLIER: "Suspicious new accounts",
  PLATEAU_AT_CAP: "Views stopped at the payout cap",
  DELETED_OR_PRIVATE_AFTER_LOCK: "Deleted after lock",
  VIEW_DROP_AFTER_LOCK: "Views removed by the platform",
  DUPLICATE_SUBMISSION: "Duplicate submissions",
  MULTI_ACCOUNT_LINK: "One person, many accounts",
  RULE_VIOLATION_HINTS: "Missing required tags",
};

export default async function FunderCampaign({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requirePageUser();
  const campaign = await db.campaign.findUnique({ where: { id }, include: { organization: true } });
  if (!campaign) notFound();
  try {
    await requireOrgMember(user.id, campaign.organizationId, user.roles.includes("ADMIN"));
  } catch {
    notFound();
  }
  const a = await campaignAnalytics(campaign);
  const needsFunding = campaign.status === "DRAFT" || campaign.status === "PENDING_FUNDING";
  const breakdown = fundingBreakdown(campaign.budgetPaise, campaign.platformFeeBps, campaign.gstOnFeeBps);
  const blocked = await db.submission.findMany({
    where: { campaignId: id, status: { in: ["VOIDED", "REJECTED", "CLAWED_BACK", "FLAGGED"] } },
    include: {
      fraudSignals: { where: { score: { gte: 50 } }, orderBy: { score: "desc" } },
      socialAccount: { select: { handle: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 12,
  });

  return (
    <div>
      <PageHeader
        eyebrow={`${campaign.organization.name}${campaign.isManaged ? " · managed campaign" : ""}`}
        title={campaign.title}
        actions={
          <>
            <CampaignStatusBadge status={campaign.status} />
            {!needsFunding ? (
              <a
                href={`/funder/campaigns/${id}/export`}
                className="border-border text-muted hover:text-fg rounded-full border px-3 py-1 text-sm"
              >
                Export CSV
              </a>
            ) : null}
            <Link
              href={`/campaigns/${id}`}
              className="border-border text-muted hover:text-fg rounded-full border px-3 py-1 text-sm"
            >
              Public page
            </Link>
          </>
        }
      />
      {sp.funded === "1" ? (
        <Card className="border-good/40 bg-good/5 text-good mb-6 text-sm">
          Payment confirmed — your campaign is live.
        </Card>
      ) : null}
      {sp.funded === "0" ? (
        <Card className="border-bad/40 bg-bad/5 text-bad mb-6 text-sm">Payment was declined. Try again.</Card>
      ) : null}

      {needsFunding ? (
        <Card className="mb-8 max-w-xl">
          <h2 className="font-serif text-xl">Fund to go live</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Budget</dt>
              <dd className="tabular">{formatINR(breakdown.budgetPaise)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Platform fee ({campaign.platformFeeBps / 100}%)</dt>
              <dd className="tabular">{formatINR(breakdown.feePaise)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">GST on fee ({campaign.gstOnFeeBps / 100}%)</dt>
              <dd className="tabular">{formatINR(breakdown.gstPaise)}</dd>
            </div>
            <div className="border-border flex justify-between border-t pt-2 font-medium">
              <dt>Total</dt>
              <dd className="tabular">{formatINR(breakdown.totalPaise)}</dd>
            </div>
          </dl>
          <ActionForm action={fundAction} className="mt-5">
            <input type="hidden" name="campaignId" value={id} />
            <SubmitButton className="w-full">Pay {formatINR(breakdown.totalPaise)}</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {needsFunding ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Verified views"
              value={formatViewsIndian(a.verifiedViews)}
              hint={`${a.submissions} posts · ${a.clippers} clippers`}
            />
            <Stat
              label="Spend"
              value={formatINRCompact(a.spendPaise)}
              hint={`${formatINRCompact(a.clearedPaise)} cleared · ${formatINRCompact(a.reservedPaise)} reserved`}
            />
            <Stat
              label="Effective cost / 1K"
              value={a.effectiveCpmPaise !== null ? formatINR(a.effectiveCpmPaise) : "—"}
              hint={`rate ${formatINR(campaign.ratePer1kViewsPaise)}`}
            />
            <Stat
              label="Budget left"
              value={formatINRCompact(a.remainingPaise)}
              hint={`of ${formatINRCompact(campaign.budgetPaise)}`}
            />
          </div>

          <Section title="Fraud blocked">
            <div className="border-accent/30 bg-accent/5 rounded-3xl border p-6 md:p-8">
              <div className="grid gap-6 md:grid-cols-3">
                <div>
                  <div className="text-accent text-xs tracking-wide uppercase">Saved</div>
                  <div className="tabular text-accent mt-1 font-serif text-5xl">
                    {formatINRCompact(a.fraud.savedPaise)}
                  </div>
                  <div className="text-muted mt-1 text-sm">you did not pay for fake or ineligible views</div>
                </div>
                <div>
                  <div className="text-muted text-xs tracking-wide uppercase">Views rejected</div>
                  <div className="tabular mt-1 font-serif text-4xl">
                    {formatViewsIndian(a.fraud.blockedViews)}
                  </div>
                  <div className="text-muted mt-1 text-sm">across {a.fraud.blockedSubmissions} posts</div>
                </div>
                <div>
                  <div className="text-muted text-xs tracking-wide uppercase">In review now</div>
                  <div className="tabular mt-1 font-serif text-4xl">{a.fraud.underReview}</div>
                  <div className="text-muted mt-1 text-sm">earnings frozen until a reviewer decides</div>
                </div>
              </div>
              {a.fraud.reasons.length ? (
                <div className="mt-6 flex flex-wrap gap-2">
                  {a.fraud.reasons.map((r) => (
                    <span
                      key={r.ruleKey}
                      className="border-border bg-bg rounded-full border px-3 py-1 text-sm"
                    >
                      {RULE_LABELS[r.ruleKey] ?? r.ruleKey} <span className="text-muted">× {r.count}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {blocked.length ? (
                <ul className="mt-6 space-y-2">
                  {blocked.map((b) => (
                    <li key={b.id} className="border-border bg-bg rounded-xl border px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">@{b.socialAccount.handle}</span>
                        <SubmissionStatusBadge status={b.status} />
                      </div>
                      <p className="text-muted mt-1">
                        {b.fraudSignals[0]?.funderExplanation ??
                          b.rejectionReason ??
                          "Did not pass verification."}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Section>

          <Section title="Verified views over time">
            <Card>
              <ViewsChart points={a.daily} />
            </Card>
          </Section>

          <Section title="Top clips">
            {a.top.length === 0 ? (
              <p className="text-muted text-sm">No clips yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Clipper</Th>
                    <Th>Platform</Th>
                    <Th className="text-right">Views</Th>
                    <Th className="text-right">Earned</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.top.map((t) => (
                    <tr key={t.id}>
                      <Td>
                        <a
                          href={t.postUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:text-accent"
                        >
                          @{t.handle}
                        </a>
                      </Td>
                      <Td>
                        <PlatformBadge platform={t.platform} />
                      </Td>
                      <Td className="tabular text-right">{t.views.toLocaleString("en-IN")}</Td>
                      <Td className="tabular text-right">{formatINR(t.earnedPaise)}</Td>
                      <Td>
                        <SubmissionStatusBadge status={t.status as never} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </>
      )}

      {!needsFunding && campaign.status !== "SETTLED" ? (
        <Section title="Controls">
          <div className="flex flex-wrap gap-2">
            {campaign.status === "ACTIVE" ? <Control id={id} op="pause" label="Pause" /> : null}
            {campaign.status === "PAUSED" ? <Control id={id} op="resume" label="Resume" /> : null}
            {["ACTIVE", "PAUSED", "EXHAUSTED"].includes(campaign.status) ? (
              <Control id={id} op="end" label="End campaign" danger />
            ) : null}
          </div>
          <p className="text-muted mt-2 text-xs">
            Ending stops new posts. Posts already tracking finish their window; unused budget is then set
            aside for refund.
          </p>
        </Section>
      ) : null}
    </div>
  );
}

function Control({ id, op, label, danger }: { id: string; op: string; label: string; danger?: boolean }) {
  return (
    <ActionForm action={campaignControlAction} className="space-y-0">
      <input type="hidden" name="campaignId" value={id} />
      <input type="hidden" name="op" value={op} />
      <SubmitButton variant={danger ? "danger" : "secondary"} size="sm">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}
