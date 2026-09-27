import Link from "next/link";
import { Empty, PageHeader } from "@/components/page";
import { PlatformBadge, SubmissionStatusBadge } from "@/components/status";
import { Table, Td, Th } from "@/components/ui/table";
import { targetEarnings } from "@/domain/accrual";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { requirePageUser } from "@/lib/session";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "My submissions" };

export default async function SubmissionsPage() {
  const user = await requirePageUser("CLIPPER");
  const subs = await db.submission.findMany({
    where: { clipperId: user.id },
    orderBy: { submittedAt: "desc" },
    include: { campaign: true, snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  return (
    <div>
      <PageHeader eyebrow="Clipper" title="My submissions" />
      {subs.length === 0 ? (
        <Empty>
          No submissions yet.{" "}
          <Link className="text-accent underline" href="/campaigns">
            Find a campaign
          </Link>
          .
        </Empty>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {subs.map((s) => (
              <Link
                key={s.id}
                href={`/clipper/submissions/${s.id}`}
                className="border-border bg-surface block rounded-2xl border p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{s.campaign.title}</span>
                  <SubmissionStatusBadge status={s.status} />
                </div>
                <div className="text-muted mt-2 flex justify-between text-sm">
                  <span>{(s.snapshots[0]?.views ?? 0).toLocaleString("en-IN")} views</span>
                  <span className="tabular text-fg">{formatINR(s.earnedPaise)}</span>
                </div>
              </Link>
            ))}
          </div>
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Platform</Th>
                  <Th>Submitted</Th>
                  <Th className="text-right">Views</Th>
                  <Th className="text-right">Estimated</Th>
                  <Th className="text-right">Confirmed</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => {
                  const views = s.snapshots[0]?.views ?? 0;
                  const estimate = targetEarnings(s.campaign, s.lockedViews ?? views);
                  return (
                    <tr key={s.id} className="hover:bg-surface">
                      <Td>
                        <Link className="hover:text-accent" href={`/clipper/submissions/${s.id}`}>
                          {s.campaign.title}
                        </Link>
                      </Td>
                      <Td>
                        <PlatformBadge platform={s.platform} />
                      </Td>
                      <Td className="text-muted">{formatDate(s.submittedAt)}</Td>
                      <Td className="tabular text-right">{views.toLocaleString("en-IN")}</Td>
                      <Td className="tabular text-muted text-right">
                        {["REJECTED", "VOIDED", "CLAWED_BACK"].includes(s.status) ? "—" : formatINR(estimate)}
                      </Td>
                      <Td className="tabular text-right">{formatINR(s.earnedPaise)}</Td>
                      <Td>
                        <SubmissionStatusBadge status={s.status} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
