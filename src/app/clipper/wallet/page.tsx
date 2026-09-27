import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { PayoutStatusBadge } from "@/components/status";
import { Card, Stat } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { walletSummary } from "@/domain/payouts";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { requirePageUser } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { withdrawAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet" };

export default async function WalletPage() {
  const user = await requirePageUser("CLIPPER");
  const [w, payouts, profile, open] = await Promise.all([
    walletSummary(user.id),
    db.payout.findMany({ where: { userId: user.id }, orderBy: { requestedAt: "desc" } }),
    db.payoutProfile.findUnique({ where: { userId: user.id } }),
    db.payout.count({ where: { userId: user.id, status: { in: ["PENDING", "APPROVED", "PROCESSING"] } } }),
  ]);
  const canWithdraw = !!profile && !user.flaggedAt && open === 0 && w.payablePaise >= w.minWithdrawalPaise;
  return (
    <div>
      <PageHeader eyebrow="Clipper" title="Wallet" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Payable" value={formatINR(w.payablePaise)} hint="cleared, ready to withdraw" accent />
        <Stat label="Pending" value={formatINR(w.pendingPaise)} hint="reserved while tracking & on hold" />
        <Stat label="In flight" value={formatINR(w.inFlightPaise)} hint="requested withdrawals" />
        <Stat
          label="Paid out (net)"
          value={formatINR(w.paidOutNetPaise)}
          hint={`TDS withheld ${formatINR(w.tdsWithheldPaise)}`}
        />
      </div>
      {w.payablePaise < 0n ? (
        <Card className="border-bad/40 bg-bad/5 mt-6 text-sm">
          Your balance is negative because earnings were clawed back after a fraud review. It will be offset
          against future earnings.
        </Card>
      ) : null}

      <Section title="Withdraw">
        <Card className="max-w-xl">
          {!profile ? (
            <p className="text-muted text-sm">
              <Link href="/clipper/accounts#payout" className="text-accent underline">
                Add your UPI ID
              </Link>{" "}
              to withdraw.
            </p>
          ) : user.flaggedAt ? (
            <p className="text-bad text-sm">Withdrawals are paused while your account is under review.</p>
          ) : open > 0 ? (
            <p className="text-muted text-sm">You have a withdrawal in progress.</p>
          ) : (
            <ActionForm action={withdrawAction}>
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <p className="text-muted text-sm">
                Withdraw your full payable balance of{" "}
                <strong className="text-fg">{formatINR(w.payablePaise)}</strong> to{" "}
                <span className="font-mono">{profile.maskedUpiId}</span>. Minimum{" "}
                {formatINR(w.minWithdrawalPaise)}. TDS is calculated when you request and shown below.
              </p>
              <SubmitButton disabled={!canWithdraw}>
                Withdraw {formatINR(w.payablePaise > 0n ? w.payablePaise : 0n)}
              </SubmitButton>
            </ActionForm>
          )}
        </Card>
      </Section>

      <Section title="Payout history">
        {payouts.length === 0 ? (
          <p className="text-muted text-sm">No payouts yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Requested</Th>
                <Th className="text-right">Gross</Th>
                <Th className="text-right">TDS</Th>
                <Th className="text-right">Net to UPI</Th>
                <Th>Status</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id}>
                  <Td className="text-muted">{formatDate(p.requestedAt)}</Td>
                  <Td className="tabular text-right">{formatINR(p.grossPaise)}</Td>
                  <Td className="tabular text-right">{formatINR(p.tdsPaise)}</Td>
                  <Td className="tabular text-right">{formatINR(p.netPaise)}</Td>
                  <Td>
                    <PayoutStatusBadge status={p.status} />
                  </Td>
                  <Td className="text-muted max-w-sm text-xs">
                    {p.failureReason ?? p.tdsExplanation}
                    {p.paidAt ? ` · paid ${formatDate(p.paidAt)} to ${p.maskedUpiId}` : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </div>
  );
}
