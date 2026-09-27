import type { Campaign, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Paise } from "@/lib/money";
import { acct, balances } from "@/ledger/ledger";

/** Read models shared by pages. */

export type CampaignCard = Campaign & {
  remainingPaise: Paise;
  clipperCount: number;
  submissionCount: number;
};

export async function campaignCards(where: Prisma.CampaignWhereInput, take = 60): Promise<CampaignCard[]> {
  const campaigns = await db.campaign.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take,
    include: { _count: { select: { participations: true, submissions: true } } },
  });
  const bal = await balances(
    db,
    campaigns.map((c) => acct.campaignBudget(c.id)),
  );
  return campaigns.map(({ _count, ...c }) => ({
    ...c,
    remainingPaise: bal.get(acct.campaignBudget(c.id)) ?? 0n,
    clipperCount: _count.participations,
    submissionCount: _count.submissions,
  }));
}

export async function publicCampaigns() {
  return campaignCards({ status: { in: ["ACTIVE", "EXHAUSTED", "PAUSED"] } });
}
