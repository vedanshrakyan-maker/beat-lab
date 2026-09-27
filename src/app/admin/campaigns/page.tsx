import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { CampaignStatusBadge } from "@/components/status";
import { LinkButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Table, Td, Th } from "@/components/ui/table";
import { devtoolsEnabled } from "@/domain/devtools";
import { campaignCards } from "@/domain/queries";
import { db } from "@/lib/db";
import { formatINR, formatINRCompact } from "@/lib/money";
import { acct, balances } from "@/ledger/ledger";
import { fastForwardAction, refundAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns · Admin" };

export default async function AdminCampaigns() {
  const campaigns = await campaignCards({}, 200);
  const orgs = await db.organization.findMany({ orderBy: { name: "asc" } });
  const refunds = await balances(
    db,
    orgs.map((o) => acct.refundPayable(o.id)),
  );
  const owed = orgs.filter((o) => (refunds.get(acct.refundPayable(o.id)) ?? 0n) > 0n);
  const dev = devtoolsEnabled();
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Campaigns"
        actions={<LinkButton href="/admin/campaigns/new">New managed campaign</LinkButton>}
      />
      <Table>
        <thead>
          <tr>
            <Th>Campaign</Th>
            <Th>Org</Th>
            <Th className="text-right">Rate</Th>
            <Th className="text-right">Left / budget</Th>
            <Th className="text-right">Posts</Th>
            <Th>Status</Th>
            {dev ? <Th>Dev</Th> : null}
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <Td>
                <Link href={`/funder/campaigns/${c.id}`} className="hover:text-accent">
                  {c.title}
                </Link>
                {c.isManaged ? <div className="text-muted text-xs">managed</div> : null}
              </Td>
              <Td className="text-muted">{orgs.find((o) => o.id === c.organizationId)?.name}</Td>
              <Td className="tabular text-right">{formatINR(c.ratePer1kViewsPaise)}</Td>
              <Td className="tabular text-right">
                {formatINRCompact(c.remainingPaise)} / {formatINRCompact(c.budgetPaise)}
              </Td>
              <Td className="tabular text-right">{c.submissionCount}</Td>
              <Td>
                <CampaignStatusBadge status={c.status} />
              </Td>
              {dev ? (
                <Td>
                  {["ACTIVE", "EXHAUSTED", "PAUSED", "ENDED"].includes(c.status) ? (
                    <ActionForm action={fastForwardAction} className="flex gap-1 space-y-0">
                      <input type="hidden" name="campaignId" value={c.id} />
                      <Input name="hours" type="number" defaultValue={24} className="h-8 w-20 py-1 text-xs" />
                      <SubmitButton size="sm" variant="secondary">
                        +h
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </Td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </Table>

      <Section title="Refunds owed">
        {owed.length === 0 ? <p className="text-muted text-sm">No unused budget awaiting refund.</p> : null}
        <div className="space-y-2">
          {owed.map((o) => (
            <div
              key={o.id}
              className="border-border bg-surface flex items-center justify-between rounded-xl border px-4 py-3"
            >
              <span>{o.name}</span>
              <ActionForm action={refundAction} className="flex items-center gap-3 space-y-0">
                <input type="hidden" name="organizationId" value={o.id} />
                <span className="tabular">{formatINR(refunds.get(acct.refundPayable(o.id))!)}</span>
                <SubmitButton size="sm" variant="secondary">
                  Record refund sent
                </SubmitButton>
              </ActionForm>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
