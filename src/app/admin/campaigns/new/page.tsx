import { CampaignForm } from "@/components/campaign-form";
import { PageHeader } from "@/components/page";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { createCampaignAction } from "../../../funder/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New managed campaign" };

export default async function NewManagedCampaign() {
  const orgs = await db.organization.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  const d = await getSetting("campaignDefaults");
  return (
    <div>
      <PageHeader
        eyebrow="Admin · managed campaign"
        title="Run a campaign for a funder"
        subtitle="Created on the funder's behalf; the funder sees it in their dashboard and funds it as usual."
      />
      <CampaignForm
        action={createCampaignAction}
        organizations={orgs}
        managed
        feeBps={d.platformFeeBps}
        gstBps={d.gstOnFeeBps}
        trackingWindowDays={d.trackingWindowDays}
        holdPeriodDays={d.holdPeriodDays}
      />
    </div>
  );
}
