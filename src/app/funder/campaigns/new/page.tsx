import { CampaignForm } from "@/components/campaign-form";
import { PageHeader } from "@/components/page";
import { LinkButton } from "@/components/ui/button";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { requirePageUser } from "@/lib/session";
import { createCampaignAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New campaign" };

export default async function NewCampaign() {
  const user = await requirePageUser();
  const orgs = await db.organization.findMany({
    where: { members: { some: { userId: user.id } } },
    select: { id: true, name: true },
  });
  const d = await getSetting("campaignDefaults");
  if (!user.roles.includes("FUNDER") || orgs.length === 0) {
    return (
      <div>
        <PageHeader
          title="Create an organization first"
          subtitle="Campaigns belong to an organization (creator, podcast or brand)."
        />
        <LinkButton href="/funder">Set up organization</LinkButton>
      </div>
    );
  }
  return (
    <div>
      <PageHeader eyebrow="Funder" title="New campaign" />
      <CampaignForm
        action={createCampaignAction}
        organizations={orgs}
        feeBps={d.platformFeeBps}
        gstBps={d.gstOnFeeBps}
        trackingWindowDays={d.trackingWindowDays}
        holdPeriodDays={d.holdPeriodDays}
      />
    </div>
  );
}
