import type { Platform } from "@prisma/client";
import { userActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { env } from "@/env";
import { createCampaign, type CampaignInput } from "@/domain/campaigns";
import { handlePaymentWebhook, startFunding } from "@/domain/funding";
import { connectMockAccount } from "@/domain/social-accounts";
import { joinCampaign } from "@/domain/submissions";
import { MockPaymentProvider, MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/payments/mock";
import { truncateAll } from "../truncate";

export async function resetDb() {
  await truncateAll(process.env.DATABASE_URL!);
  await db.taxRule.create({
    data: {
      name: "Professional/contract fees — CONFIRM WITH CA",
      appliesTo: "CLIPPER_PAYOUT",
      ratePctBps: 1000,
      rateWithoutPanBps: 2000,
      annualThresholdPaise: 30_000_00n,
      sectionLabel: "PLACEHOLDER — CONFIRM WITH CA",
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    },
  });
}

let counter = 0;
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function makeUser(roles: ("FUNDER" | "CLIPPER" | "ADMIN")[], name = "User") {
  return db.user.create({
    data: { email: `${name.toLowerCase().replace(/\W/g, "")}.${uid()}@test.local`, name, roles },
  });
}

export async function makeFunder() {
  const user = await makeUser(["FUNDER"], "Funder");
  const org = await db.organization.create({
    data: {
      name: `Org ${uid()}`,
      billingEmail: user.email,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  return { user, org };
}

export async function makeClipper(platform: Platform = "INSTAGRAM", followerCount = 20_000) {
  const user = await makeUser(["CLIPPER"], "Clipper");
  const account = await connectMockAccount(user.id, platform, `clip_${uid()}`, userActor(user.id), {
    followerCount,
    accountCreatedAt: new Date("2023-01-01T00:00:00Z"),
  });
  return { user, account };
}

export const mockProvider = () => new MockPaymentProvider(env().MOCK_WEBHOOK_SECRET, env().APP_URL);

export function signedWebhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(rawBody, env().MOCK_WEBHOOK_SECRET) }),
  };
}

export async function payOrder(providerOrderId: string, eventId = `evt_${uid()}`) {
  const payment = await db.fundingPayment.findUniqueOrThrow({ where: { providerOrderId } });
  return handlePaymentWebhook(
    mockProvider(),
    signedWebhook({
      type: "funding.paid",
      eventId,
      providerOrderId,
      providerPaymentId: `pay_${uid()}`,
      amountPaise: payment.amountPaise.toString(),
    }),
  );
}

export function campaignInput(organizationId: string, overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    organizationId,
    title: `Campaign ${uid()}`,
    description: "Clip our podcast into short, punchy reels.",
    type: "CLIPPING",
    sourceContentUrls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    rules: { requiredHashtags: ["#reelpay"], requiredMentions: [] },
    allowedPlatforms: ["INSTAGRAM", "YOUTUBE"],
    ratePer1kViewsPaise: 3000n,
    budgetPaise: 1_00_000_00n,
    platformFeeBps: 1000,
    gstOnFeeBps: 1800,
    maxPayoutPerSubmissionPaise: 20_000_00n,
    maxPayoutPerClipperPaise: null,
    minViewsToQualify: 0,
    trackingWindowDays: 7,
    holdPeriodDays: 7,
    ...overrides,
  };
}

export async function makeActiveCampaign(overrides: Partial<CampaignInput> = {}) {
  const { user, org } = await makeFunder();
  const campaign = await createCampaign(campaignInput(org.id, overrides), user.id, userActor(user.id));
  const order = await startFunding(campaign.id, userActor(user.id), mockProvider());
  await payOrder(order.providerOrderId);
  return { funder: user, org, campaign: await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } }) };
}

export async function joined(campaignId: string, platform: Platform = "INSTAGRAM", followerCount = 20_000) {
  const clipper = await makeClipper(platform, followerCount);
  await joinCampaign(clipper.user.id, campaignId, userActor(clipper.user.id));
  return clipper;
}

let postCounter = 0;
export function reelUrl(scenario?: string) {
  const code = `T${Date.now().toString(36)}${(postCounter++).toString(36)}`.slice(0, 20);
  return `https://www.instagram.com/reel/${code}/${scenario ? `?mock=${scenario.toLowerCase()}` : ""}`;
}

export const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
