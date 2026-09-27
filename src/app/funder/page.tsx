import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/page";
import { CampaignStatusBadge } from "@/components/status";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Progress } from "@/components/ui/progress";
import { campaignCards } from "@/domain/queries";
import { db } from "@/lib/db";
import { formatINR, formatINRCompact } from "@/lib/money";
import { requirePageUser } from "@/lib/session";
import { createOrgAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Funder" };

export default async function FunderHome() {
  const user = await requirePageUser();
  const orgs = await db.organization.findMany({ where: { members: { some: { userId: user.id } } } });
  if (orgs.length === 0) {
    return (
      <div className="max-w-xl">
        <PageHeader
          eyebrow="Funder"
          title="Set up your organization"
          subtitle="Creators, podcasts and brands fund campaigns through an organization."
        />
        <Card>
          <ActionForm action={createOrgAction}>
            <Field label="Name">
              <Input name="name" required placeholder="Chai Pe Charcha Podcast" />
            </Field>
            <Field label="Billing email">
              <Input name="billingEmail" type="email" required defaultValue={user.email} />
            </Field>
            <Field label="GSTIN (optional)" hint="For GST invoices on the platform fee.">
              <Input name="gstin" placeholder="27ABCDE1234F1Z5" />
            </Field>
            <SubmitButton>Create organization</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    );
  }
  const campaigns = await campaignCards({ organizationId: { in: orgs.map((o) => o.id) } });
  return (
    <div>
      <PageHeader
        eyebrow="Funder"
        title={orgs.map((o) => o.name).join(", ")}
        actions={<LinkButton href="/funder/campaigns/new">New campaign</LinkButton>}
      />
      <Section title="Campaigns">
        {campaigns.length === 0 ? <Empty>No campaigns yet.</Empty> : null}
        <div className="space-y-3">
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/funder/campaigns/${c.id}`}
              className="border-border bg-surface hover:border-fg/30 grid gap-3 rounded-2xl border p-5 md:grid-cols-[1fr_220px_140px] md:items-center"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-serif text-lg">{c.title}</span>
                  {c.isManaged ? <span className="text-muted text-xs">managed</span> : null}
                </div>
                <div className="text-muted text-sm">
                  {formatINR(c.ratePer1kViewsPaise)} / 1K views · {c.clipperCount} clippers ·{" "}
                  {c.submissionCount} posts
                </div>
              </div>
              <div>
                <Progress value={c.budgetPaise - c.remainingPaise} max={c.budgetPaise} />
                <div className="text-muted mt-1 text-xs">
                  {formatINRCompact(c.budgetPaise - c.remainingPaise)} of {formatINRCompact(c.budgetPaise)}{" "}
                  used
                </div>
              </div>
              <div className="md:text-right">
                <CampaignStatusBadge status={c.status} />
              </div>
            </Link>
          ))}
        </div>
      </Section>
    </div>
  );
}
