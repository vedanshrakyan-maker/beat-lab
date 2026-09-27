import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { PlatformBadge, SubmissionStatusBadge } from "@/components/status";
import { SubmissionTimeline } from "@/components/timeline";
import { Card, Stat } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ViewsChart } from "@/components/views-chart";
import { capViewsFor, targetEarnings } from "@/domain/accrual";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { requirePageUser } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { uploadEvidenceAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function SubmissionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser("CLIPPER");
  const s = await db.submission.findUnique({
    where: { id },
    include: {
      campaign: true,
      socialAccount: true,
      snapshots: { orderBy: { capturedAt: "asc" } },
      manualEvidence: { orderBy: { createdAt: "desc" } },
      fraudSignals: { where: { score: { gte: 15 } }, orderBy: { score: "desc" } },
    },
  });
  if (!s || s.clipperId !== user.id) notFound();
  const latest = s.snapshots[s.snapshots.length - 1];
  const views = latest?.views ?? 0;
  const estimate = targetEarnings(s.campaign, s.finalViews ?? s.lockedViews ?? views);
  const closed = ["REJECTED", "VOIDED", "CLAWED_BACK"].includes(s.status);
  const needsEvidence = s.metricsSource === "UNAVAILABLE" || s.metricsSource === "MANUAL";
  const adjustments = await db.ledgerTransaction.findMany({
    where: { submissionId: s.id, kind: { in: ["RELEASE", "CLAWBACK"] } },
  });

  return (
    <div>
      <PageHeader
        eyebrow={s.campaign.title}
        title={<span className="break-all">@{s.socialAccount.handle}</span>}
        subtitle={
          <a
            href={s.postUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm break-all underline"
          >
            {s.postUrl}
          </a>
        }
        actions={
          <>
            <PlatformBadge platform={s.platform} />
            <SubmissionStatusBadge status={s.status} />
          </>
        }
      />
      {closed || s.rejectionReason ? (
        <Card className="border-bad/40 bg-bad/5 mb-6">
          <div className="text-bad text-xs tracking-wide uppercase">Why</div>
          <p className="mt-1">{s.rejectionReason ?? "Closed"}</p>
        </Card>
      ) : null}
      {s.status === "FLAGGED" || s.status === "UNDER_REVIEW" || s.reviewState === "NEEDS_REVIEW" ? (
        <Card className="border-warn/40 bg-warn/5 mb-6 text-sm">
          This post is in manual review.{" "}
          {s.status === "FLAGGED"
            ? "Earnings are frozen until a reviewer decides."
            : "We keep tracking views meanwhile."}
          {s.fraudSignals.length ? (
            <ul className="text-muted mt-2 list-disc pl-5">
              {s.fraudSignals.slice(0, 3).map((f) => (
                <li key={f.id}>{f.funderExplanation}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Card className="mb-6">
        <SubmissionTimeline s={s} />
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Views"
          value={views.toLocaleString("en-IN")}
          hint={latest ? `as of ${formatDate(latest.capturedAt, true)}` : "waiting for first snapshot"}
        />
        <Stat
          label="Estimated earnings"
          value={closed ? "—" : formatINR(estimate)}
          hint={`${formatINR(s.campaign.ratePer1kViewsPaise)} per 1K views, capped`}
        />
        <Stat
          label="Confirmed"
          value={formatINR(s.earnedPaise)}
          hint={s.status === "PAYABLE" || s.status === "PAID" ? "in your wallet" : "reserved from the budget"}
          accent
        />
      </div>

      <Section title="Views">
        <Card>
          <ViewsChart
            points={s.snapshots.map((p) => ({ t: p.capturedAt, v: p.views }))}
            lockedAt={s.lockedAt}
            capViews={capViewsFor(s.campaign)}
          />
        </Card>
      </Section>

      {adjustments.length ? (
        <Section title="Adjustments">
          <ul className="space-y-2 text-sm">
            {adjustments.map((a) => (
              <li key={a.id} className="border-border bg-surface rounded-xl border px-4 py-3">
                {a.description}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {needsEvidence && !closed ? (
        <Section title="Manual verification">
          <Card className="max-w-xl">
            <p className="text-muted mb-4 text-sm">
              The platform doesn&apos;t give us insights for this post. Upload a screen recording of your
              in-app insights (views, reach, likes) — an admin will verify the numbers.
            </p>
            {s.manualEvidence.length ? (
              <ul className="mb-4 space-y-1 text-sm">
                {s.manualEvidence.map((e) => (
                  <li key={e.id}>
                    {e.fileName} · {formatDate(e.createdAt, true)} ·{" "}
                    {e.reviewedAt ? "reviewed" : "awaiting review"}
                  </li>
                ))}
              </ul>
            ) : null}
            <ActionForm action={uploadEvidenceAction}>
              <input type="hidden" name="submissionId" value={s.id} />
              <Field label="Screen recording (MP4/MOV/WebM, max 50 MB)">
                <Input
                  name="file"
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,image/png,image/jpeg"
                  required
                />
              </Field>
              <Field label="Note (optional)">
                <Input name="note" />
              </Field>
              <SubmitButton>Upload</SubmitButton>
            </ActionForm>
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
