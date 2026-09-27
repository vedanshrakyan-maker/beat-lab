import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { FraudScoreBadge, PlatformBadge, SubmissionStatusBadge } from "@/components/status";
import { SubmissionTimeline } from "@/components/timeline";
import { Badge } from "@/components/ui/badge";
import { Card, Stat } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Table, Td, Th } from "@/components/ui/table";
import { ViewsChart } from "@/components/views-chart";
import { capViewsFor } from "@/domain/accrual";
import { devtoolsEnabled } from "@/domain/devtools";
import { accountLinks } from "@/domain/fraud-context";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { formatDate } from "@/lib/utils";
import { fastForwardAction, manualMetricsAction, reviewAction, userFlagAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function ReviewDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await db.submission.findUnique({
    where: { id },
    include: {
      campaign: true,
      clipper: true,
      socialAccount: true,
      snapshots: { orderBy: { capturedAt: "asc" } },
      fraudSignals: { orderBy: [{ createdAt: "desc" }, { score: "desc" }] },
      reviewDecisions: { orderBy: { createdAt: "desc" } },
      manualEvidence: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!s) notFound();
  const links = await accountLinks(db, s.clipperId);
  const ledger = await db.ledgerTransaction.findMany({
    where: { submissionId: id },
    orderBy: { createdAt: "asc" },
    include: { entries: { include: { account: true } } },
  });
  const open = !["REJECTED", "VOIDED", "CLAWED_BACK"].includes(s.status);
  const preApproval = s.status === "UNDER_REVIEW" || s.status === "SUBMITTED";

  return (
    <div>
      <PageHeader
        eyebrow={s.campaign.title}
        title={`@${s.socialAccount.handle}`}
        subtitle={
          <a className="break-all underline" href={s.postUrl} target="_blank" rel="noreferrer noopener">
            {s.postUrl}
          </a>
        }
        actions={
          <>
            <PlatformBadge platform={s.platform} />
            <SubmissionStatusBadge status={s.status} />
            <FraudScoreBadge score={s.fraudScore} />
          </>
        }
      />
      <Card className="mb-6">
        <SubmissionTimeline s={s} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Latest views"
              value={(s.snapshots[s.snapshots.length - 1]?.views ?? 0).toLocaleString("en-IN")}
              hint={`locked ${s.lockedViews?.toLocaleString("en-IN") ?? "—"}`}
            />
            <Stat label="Earned" value={formatINR(s.earnedPaise)} />
            <Stat
              label="Account"
              value={s.socialAccount.followerCount.toLocaleString("en-IN")}
              hint={`followers · created ${formatDate(s.socialAccount.accountCreatedAt)}`}
            />
          </div>
          <Card>
            <ViewsChart
              points={s.snapshots.map((p) => ({ t: p.capturedAt, v: p.views }))}
              lockedAt={s.lockedAt}
              capViews={capViewsFor(s.campaign)}
            />
          </Card>

          <Section title="Fraud signals">
            {s.fraudSignals.length === 0 ? <p className="text-muted text-sm">No signals.</p> : null}
            <div className="space-y-2">
              {s.fraudSignals.map((f) => (
                <Card key={f.id} className="py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{f.ruleKey}</span>
                    <Badge tone={f.score >= 70 ? "bad" : f.score >= 30 ? "warn" : "neutral"}>
                      score {f.score} × {f.weight}
                    </Badge>
                    <Badge>{f.phase}</Badge>
                  </div>
                  <p className="mt-2">{f.explanation}</p>
                  <details className="text-muted mt-2 text-xs">
                    <summary className="cursor-pointer">Evidence</summary>
                    <pre className="bg-bg mt-2 overflow-x-auto rounded-lg p-3">
                      {JSON.stringify(f.evidence, null, 2)}
                    </pre>
                  </details>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="Snapshots">
            <Table>
              <thead>
                <tr>
                  <Th>Captured</Th>
                  <Th>Slot</Th>
                  <Th className="text-right">Views</Th>
                  <Th className="text-right">Reach</Th>
                  <Th className="text-right">Likes</Th>
                  <Th className="text-right">Comments</Th>
                  <Th className="text-right">Shares</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {s.snapshots.map((p) => (
                  <tr key={p.id}>
                    <Td className="text-muted text-xs">{formatDate(p.capturedAt, true)}</Td>
                    <Td className="font-mono text-xs">
                      {p.slot === 1000 ? "LOCK" : p.slot === 2000 ? "HOLD END" : p.slot}
                    </Td>
                    <Td className="tabular text-right">{p.views.toLocaleString("en-IN")}</Td>
                    <Td className="tabular text-right">{p.reach?.toLocaleString("en-IN") ?? "—"}</Td>
                    <Td className="tabular text-right">{p.likes.toLocaleString("en-IN")}</Td>
                    <Td className="tabular text-right">{p.comments.toLocaleString("en-IN")}</Td>
                    <Td className="tabular text-right">{p.shares.toLocaleString("en-IN")}</Td>
                    <Td>
                      <Badge tone={p.source === "MANUAL" ? "warn" : "neutral"}>{p.source}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>

          <Section title="Ledger">
            {ledger.length === 0 ? (
              <p className="text-muted text-sm">No money has moved for this submission.</p>
            ) : null}
            <ul className="space-y-1 text-xs">
              {ledger.map((t) => (
                <li key={t.id} className="border-border rounded-lg border px-3 py-2">
                  <span className="font-mono">{t.kind}</span> · {t.description}
                  <div className="text-muted">
                    {t.entries
                      .map(
                        (e) =>
                          `${e.account.code.split(":")[0]} ${e.amountPaise > 0n ? "Dr" : "Cr"} ${formatINR(e.amountPaise > 0n ? e.amountPaise : -e.amountPaise)}`,
                      )
                      .join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <aside className="space-y-4">
          {open ? (
            <Card>
              <h2 className="font-serif text-xl">Decision</h2>
              <ActionForm action={reviewAction} className="mt-4">
                <input type="hidden" name="submissionId" value={s.id} />
                <Field label="Reason (required)">
                  <Textarea name="reason" required minLength={5} placeholder="What did you check and why?" />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <SubmitButton name="decision" value="approve">
                    Approve
                  </SubmitButton>
                  {preApproval ? (
                    <SubmitButton name="decision" value="reject" variant="danger">
                      Reject
                    </SubmitButton>
                  ) : (
                    <SubmitButton name="decision" value="void" variant="danger">
                      Void{s.status === "PAYABLE" || s.status === "PAID" ? " & claw back" : ""}
                    </SubmitButton>
                  )}
                </div>
              </ActionForm>
            </Card>
          ) : null}

          <Card>
            <h2 className="font-serif text-xl">Clipper</h2>
            <p className="mt-2 text-sm">
              {s.clipper.name} · {s.clipper.email}
            </p>
            <p className="text-muted text-xs">
              Risk {s.clipper.riskScore} · status {s.clipper.status}
              {s.clipper.flaggedAt ? ` · flagged: ${s.clipper.flagReason}` : ""}
            </p>
            <p className="text-muted mt-2 text-xs">
              Links: UPI shared with {links.sharedUpiUsers}, PAN with {links.sharedPanUsers}, device with{" "}
              {links.sharedDeviceUsers}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {s.clipper.flaggedAt ? <UserOp userId={s.clipperId} op="clear" label="Clear flag" /> : null}
              {s.clipper.status === "ACTIVE" ? (
                <UserOp userId={s.clipperId} op="suspend" label="Suspend" />
              ) : (
                <UserOp userId={s.clipperId} op="activate" label="Re-activate" />
              )}
            </div>
          </Card>

          {open &&
          (s.metricsSource === "UNAVAILABLE" || s.metricsSource === "MANUAL" || s.manualEvidence.length) ? (
            <Card>
              <h2 className="font-serif text-xl">Manual metrics</h2>
              {s.manualEvidence.map((e) => (
                <a
                  key={e.id}
                  href={`/api/evidence/${e.id}`}
                  target="_blank"
                  className="text-accent mt-2 block text-sm underline"
                >
                  {e.fileName} ({Math.round(e.sizeBytes / 1024)} KB){e.note ? ` — ${e.note}` : ""}
                </a>
              ))}
              <ActionForm action={manualMetricsAction} className="mt-4" resetOnSuccess>
                <input type="hidden" name="submissionId" value={s.id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Views">
                    <Input name="views" type="number" min={0} required />
                  </Field>
                  <Field label="Reach">
                    <Input name="reach" type="number" min={0} />
                  </Field>
                  <Field label="Likes">
                    <Input name="likes" type="number" min={0} />
                  </Field>
                  <Field label="Comments">
                    <Input name="comments" type="number" min={0} />
                  </Field>
                  <Field label="Shares">
                    <Input name="shares" type="number" min={0} />
                  </Field>
                  <Field label="Saves">
                    <Input name="saves" type="number" min={0} />
                  </Field>
                </div>
                <Field label="Note">
                  <Input name="note" />
                </Field>
                <SubmitButton variant="secondary">Save metrics</SubmitButton>
              </ActionForm>
            </Card>
          ) : null}

          {devtoolsEnabled() && open ? (
            <Card className="border-warn/30">
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-xl">Time travel</h2>
                <Badge tone="warn">dev</Badge>
              </div>
              <p className="text-muted mt-1 text-xs">
                Shift this submission into the past and run every due lifecycle step with the mock adapter.
              </p>
              <ActionForm action={fastForwardAction} className="mt-3">
                <input type="hidden" name="submissionId" value={s.id} />
                <div className="flex gap-2">
                  <Input name="hours" type="number" defaultValue={24 * 15} min={1} />
                  <SubmitButton variant="secondary">Fast-forward</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          ) : null}

          {s.reviewDecisions.length ? (
            <Card>
              <h2 className="font-serif text-xl">History</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {s.reviewDecisions.map((d) => (
                  <li key={d.id}>
                    <Badge>{d.decision}</Badge>{" "}
                    <span className="text-muted">
                      {formatDate(d.createdAt, true)} · score {d.fraudScore}
                    </span>
                    <p>{d.reason}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function UserOp({ userId, op, label }: { userId: string; op: string; label: string }) {
  return (
    <ActionForm action={userFlagAction} className="space-y-0">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="op" value={op} />
      <SubmitButton size="sm" variant="secondary">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}
