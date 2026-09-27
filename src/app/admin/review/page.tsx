import Link from "next/link";
import { Empty, PageHeader } from "@/components/page";
import { FraudScoreBadge, PlatformBadge, SubmissionStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review queue" };

export default async function ReviewQueue() {
  const items = await db.submission.findMany({
    where: {
      OR: [
        { status: "FLAGGED" },
        { reviewState: "NEEDS_REVIEW", status: { notIn: ["REJECTED", "VOIDED", "CLAWED_BACK", "PAID"] } },
      ],
    },
    orderBy: [{ fraudScore: "desc" }, { submittedAt: "asc" }],
    include: {
      campaign: { select: { title: true } },
      socialAccount: { select: { handle: true, followerCount: true } },
      fraudSignals: { orderBy: { score: "desc" }, take: 2 },
      _count: { select: { manualEvidence: true } },
    },
    take: 200,
  });
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Review queue"
        subtitle="Sorted by fraud score. Every decision needs a reason and becomes a training label."
      />
      {items.length === 0 ? (
        <Empty>Queue is empty. 🎉</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Risk</Th>
              <Th>Submission</Th>
              <Th>Top signal</Th>
              <Th className="text-right">Earned</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className="hover:bg-surface">
                <Td>
                  <FraudScoreBadge score={s.fraudScore} />
                </Td>
                <Td>
                  <Link href={`/admin/review/${s.id}`} className="hover:text-accent font-medium">
                    @{s.socialAccount.handle}
                  </Link>
                  <div className="text-muted text-xs">
                    {s.campaign.title} · {timeAgo(s.submittedAt)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <PlatformBadge platform={s.platform} />
                    {s.metricsSource === "UNAVAILABLE" || s.metricsSource === "MANUAL" ? (
                      <Badge tone="warn">
                        manual metrics{s._count.manualEvidence ? ` · ${s._count.manualEvidence} upload` : ""}
                      </Badge>
                    ) : null}
                  </div>
                </Td>
                <Td className="text-muted max-w-md text-xs">
                  {s.fraudSignals[0]?.explanation ??
                    (s.metricsSource === "UNAVAILABLE"
                      ? "Insights unavailable — enter metrics from the screen recording."
                      : "—")}
                </Td>
                <Td className="tabular text-right">{formatINR(s.earnedPaise)}</Td>
                <Td>
                  <SubmissionStatusBadge status={s.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
