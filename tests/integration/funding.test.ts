import { beforeEach, describe, expect, it } from "vitest";
import { userActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { acct, balance } from "@/ledger/ledger";
import { createCampaign } from "@/domain/campaigns";
import { handlePaymentWebhook, startFunding } from "@/domain/funding";
import { campaignInput, makeFunder, mockProvider, payOrder, resetDb, signedWebhook } from "./factories";

describe("campaign funding", () => {
  beforeEach(resetDb);

  async function draft() {
    const { user, org } = await makeFunder();
    const campaign = await createCampaign(
      campaignInput(org.id, { budgetPaise: 1_00_000_00n }),
      user.id,
      userActor(user.id),
    );
    return { user, org, campaign };
  }

  it("activates only after a verified webhook, posting budget + fee + GST", async () => {
    const { user, campaign } = await draft();
    const order = await startFunding(campaign.id, userActor(user.id), mockProvider());
    expect(order.amountPaise).toBe(1_11_800_00n);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      "PENDING_FUNDING",
    );

    expect(await payOrder(order.providerOrderId, "evt_1")).toBe("processed");
    const c = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(c.status).toBe("ACTIVE");
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(1_00_000_00n);
    expect(await balance(db, acct.platformFeeRevenue())).toBe(10_000_00n);
    expect(await balance(db, acct.gstPayable())).toBe(1_800_00n);
    expect(await balance(db, acct.funderCashIn())).toBe(1_11_800_00n);
    expect(await db.notification.count({ where: { userId: user.id, kind: "CAMPAIGN_ACTIVE" } })).toBe(1);
  });

  it("processes each webhook event once, and each payment once", async () => {
    const { user, campaign } = await draft();
    const order = await startFunding(campaign.id, userActor(user.id), mockProvider());
    expect(await payOrder(order.providerOrderId, "evt_dup")).toBe("processed");
    expect(await payOrder(order.providerOrderId, "evt_dup")).toBe("duplicate");
    expect(await payOrder(order.providerOrderId, "evt_other")).toBe("processed"); // new event id, same payment: no-op
    expect(await db.ledgerTransaction.count({ where: { kind: "FUNDING" } })).toBe(1);
    expect(await balance(db, acct.campaignBudget(campaign.id))).toBe(1_00_000_00n);
  });

  it("rejects bad signatures and never activates on an amount mismatch", async () => {
    const { user, campaign } = await draft();
    const order = await startFunding(campaign.id, userActor(user.id), mockProvider());
    const req = signedWebhook({
      type: "funding.paid",
      eventId: "e",
      providerOrderId: order.providerOrderId,
      providerPaymentId: "p",
      amountPaise: "100",
    });
    expect(
      await handlePaymentWebhook(mockProvider(), {
        ...req,
        headers: new Headers({ "x-mock-signature": "nope" }),
      }),
    ).toBe("invalid_signature");
    expect(await handlePaymentWebhook(mockProvider(), req)).toBe("processed");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      "PENDING_FUNDING",
    );
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("re-opens an existing unpaid order instead of creating another", async () => {
    const { user, campaign } = await draft();
    const a = await startFunding(campaign.id, userActor(user.id), mockProvider());
    const b = await startFunding(campaign.id, userActor(user.id), mockProvider());
    expect(a.providerOrderId).toBe(b.providerOrderId);
    expect(await db.fundingPayment.count()).toBe(1);
  });
});
