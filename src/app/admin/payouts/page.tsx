import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { PayoutStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Table, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { formatDate } from "@/lib/utils";
import { payoutBatchAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payouts" };

export default async function PayoutsAdmin() {
  const [pending, batches, processing] = await Promise.all([
    db.payout.findMany({
      where: { status: "PENDING", batchId: null },
      include: { user: true },
      orderBy: { requestedAt: "asc" },
    }),
    db.payoutBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { payouts: { include: { user: { select: { name: true, email: true } } } } },
    }),
    db.payout.count({ where: { status: "PROCESSING" } }),
  ]);
  const total = pending.reduce((s, p) => s + p.grossPaise, 0n);
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Payouts"
        subtitle="Build a batch from pending withdrawals, review totals and TDS, approve. Each payout is sent with its own idempotency key."
      />
      <Section
        title={`Pending withdrawals (${pending.length})`}
        actions={
          pending.length ? (
            <ActionForm action={payoutBatchAction} className="space-y-0">
              <input type="hidden" name="op" value="create" />
              <SubmitButton size="sm">Create batch · {formatINR(total)}</SubmitButton>
            </ActionForm>
          ) : null
        }
      >
        {pending.length === 0 ? (
          <p className="text-muted text-sm">No pending withdrawals.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Clipper</Th>
                <Th>Requested</Th>
                <Th className="text-right">Gross</Th>
                <Th className="text-right">TDS</Th>
                <Th className="text-right">Net</Th>
                <Th>UPI</Th>
                <Th>Reject</Th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <Td>
                    {p.user.name}
                    <div className="text-muted text-xs">
                      {p.user.email}
                      {p.user.flaggedAt ? " · flagged (excluded from batches)" : ""}
                    </div>
                  </Td>
                  <Td className="text-muted text-xs">{formatDate(p.requestedAt, true)}</Td>
                  <Td className="tabular text-right">{formatINR(p.grossPaise)}</Td>
                  <Td className="tabular text-right">
                    {formatINR(p.tdsPaise)}
                    <div className="text-muted text-xs">{p.tdsExplanation}</div>
                  </Td>
                  <Td className="tabular text-right">{formatINR(p.netPaise)}</Td>
                  <Td className="font-mono text-xs">{p.maskedUpiId}</Td>
                  <Td>
                    <ActionForm action={payoutBatchAction} className="flex gap-1 space-y-0">
                      <input type="hidden" name="op" value="reject" />
                      <input type="hidden" name="payoutId" value={p.id} />
                      <Input name="reason" placeholder="Reason" className="h-8 w-32 py-1 text-xs" required />
                      <SubmitButton size="sm" variant="danger">
                        Reject
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section
        title="Batches"
        actions={
          processing ? (
            <ActionForm action={payoutBatchAction} className="space-y-0">
              <input type="hidden" name="op" value="sync" />
              <SubmitButton size="sm" variant="secondary">
                Sync {processing} processing
              </SubmitButton>
            </ActionForm>
          ) : null
        }
      >
        <div className="space-y-3">
          {batches.map((b) => (
            <Card key={b.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-muted font-mono text-xs">{b.id}</div>
                  <div className="mt-1 text-sm">
                    {b.payoutCount} payouts · gross{" "}
                    <span className="tabular">{formatINR(b.totalGrossPaise)}</span> · TDS{" "}
                    <span className="tabular">{formatINR(b.totalTdsPaise)}</span> · net{" "}
                    <span className="tabular font-medium">{formatINR(b.totalNetPaise)}</span>
                  </div>
                  <div className="text-muted text-xs">
                    Created {formatDate(b.createdAt, true)}
                    {b.approvedAt ? ` · approved ${formatDate(b.approvedAt, true)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      b.status === "COMPLETED"
                        ? "good"
                        : b.status === "PARTIALLY_FAILED"
                          ? "bad"
                          : b.status === "DRAFT"
                            ? "warn"
                            : "accent"
                    }
                  >
                    {b.status.replace("_", " ").toLowerCase()}
                  </Badge>
                  {b.status === "DRAFT" ? (
                    <ActionForm action={payoutBatchAction} className="space-y-0">
                      <input type="hidden" name="op" value="approve" />
                      <input type="hidden" name="batchId" value={b.id} />
                      <SubmitButton size="sm" data-testid="approve-batch">
                        Approve & send
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              </div>
              <details className="mt-3 text-sm">
                <summary className="text-muted cursor-pointer">Payouts</summary>
                <ul className="mt-2 space-y-1">
                  {b.payouts.map((p) => (
                    <li
                      key={p.id}
                      className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-1"
                    >
                      <span>
                        {p.user.name} · <span className="font-mono text-xs">{p.maskedUpiId}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular">{formatINR(p.netPaise)}</span>
                        <PayoutStatusBadge status={p.status} />
                        {p.failureReason ? <span className="text-bad text-xs">{p.failureReason}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          ))}
          {batches.length === 0 ? <p className="text-muted text-sm">No batches yet.</p> : null}
        </div>
      </Section>
    </div>
  );
}
