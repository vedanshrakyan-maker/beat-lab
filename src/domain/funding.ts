import { audit, systemActor, type Actor } from "@/lib/audit";
import { randomToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatINR, fundingBreakdown } from "@/lib/money";
import { acct, credit, debit, isUniqueViolation, post } from "@/ledger/ledger";
import { CampaignError, notifyOrgMembers, transitionCampaign } from "@/domain/campaigns";
import { getPaymentProvider } from "@/payments";
import type { FundingOrder, PaymentProvider, PaymentWebhookEvent, WebhookRequest } from "@/payments/types";
import { applyPayoutStatus } from "@/domain/payouts";

/**
 * Funding flow: the funder pays budget + platform fee + GST on the fee. Only the provider
 * webhook (signature-verified, idempotent) posts the ledger entries and activates the campaign.
 */
export async function startFunding(
  campaignId: string,
  actor: Actor,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<FundingOrder> {
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (campaign.status !== "DRAFT" && campaign.status !== "PENDING_FUNDING") {
    throw new CampaignError("Only draft campaigns can be funded");
  }
  const breakdown = fundingBreakdown(campaign.budgetPaise, campaign.platformFeeBps, campaign.gstOnFeeBps);

  // Re-use an open order for the same amount instead of creating duplicates.
  const open = await db.fundingPayment.findFirst({
    where: { campaignId, status: "CREATED", amountPaise: breakdown.totalPaise, provider: provider.name },
  });
  if (open) {
    await db.$transaction((tx) => transitionCampaign(tx, campaignId, "PENDING_FUNDING", actor));
    return provider.checkoutFor(open.providerOrderId, open.amountPaise);
  }

  const receipt = `fp_${randomToken(10)}`;
  const order = await provider.createFundingOrder({ receipt, amountPaise: breakdown.totalPaise, campaignId });
  await db.$transaction(async (tx) => {
    await tx.fundingPayment.create({
      data: {
        id: receipt,
        campaignId,
        provider: provider.name,
        providerOrderId: order.providerOrderId,
        budgetPaise: breakdown.budgetPaise,
        feePaise: breakdown.feePaise,
        gstPaise: breakdown.gstPaise,
        amountPaise: breakdown.totalPaise,
        idempotencyKey: `funding:${receipt}`,
      },
    });
    await transitionCampaign(tx, campaignId, "PENDING_FUNDING", actor);
    await audit(tx, actor, "funding.order_created", "Campaign", campaignId, undefined, {
      providerOrderId: order.providerOrderId,
      ...breakdown,
    });
  });
  return order;
}

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "invalid_signature";

/** Entry point for /api/webhooks/payments/[provider]. */
export async function handlePaymentWebhook(
  provider: PaymentProvider,
  req: WebhookRequest,
): Promise<WebhookOutcome> {
  if (!provider.verifyWebhookSignature(req)) return "invalid_signature";
  const event = provider.parseWebhook(req);
  if (event.type === "ignored") return "ignored";
  const key = `webhook:${provider.name}:${event.eventId}`;
  if (await db.idempotencyKey.findUnique({ where: { key } })) return "duplicate";
  try {
    return await db.$transaction(async (tx) => {
      // Idempotency: each provider event is processed exactly once (the unique key also
      // catches two deliveries racing each other).
      await tx.idempotencyKey.create({ data: { key, scope: "payment_webhook" } });
      await applyWebhookEvent(tx, provider.name, event);
      return "processed" as const;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function applyWebhookEvent(tx: TxClient, providerName: string, event: PaymentWebhookEvent) {
  const actor: Actor = { id: null, label: `webhook:${providerName}` };
  if (event.type === "funding.paid") {
    await tx.$queryRaw`SELECT id FROM "FundingPayment" WHERE "providerOrderId" = ${event.providerOrderId} FOR UPDATE`;
    const payment = await tx.fundingPayment.findUnique({
      where: { providerOrderId: event.providerOrderId },
      include: { campaign: true },
    });
    if (!payment) throw new Error(`Unknown funding order ${event.providerOrderId}`);
    if (payment.status === "PAID") return; // already applied via another event
    if (event.amountPaise !== payment.amountPaise) {
      // Never activate on a partial or mismatched payment: leave for an admin.
      await audit(tx, actor, "funding.amount_mismatch", "FundingPayment", payment.id, undefined, {
        expected: payment.amountPaise,
        received: event.amountPaise,
      });
      return;
    }
    const c = payment.campaign;
    await post(tx, {
      idempotencyKey: payment.idempotencyKey,
      kind: "FUNDING",
      description: `Funding for “${c.title}”: budget ${formatINR(payment.budgetPaise)} + fee ${formatINR(payment.feePaise)} + GST ${formatINR(payment.gstPaise)}`,
      campaignId: c.id,
      entries: [
        debit(acct.funderCashIn(), payment.amountPaise),
        credit(acct.campaignBudget(c.id), payment.budgetPaise),
        credit(acct.platformFeeRevenue(), payment.feePaise),
        credit(acct.gstPayable(), payment.gstPaise),
      ],
      metadata: { providerOrderId: payment.providerOrderId, providerPaymentId: event.providerPaymentId },
    });
    await tx.fundingPayment.update({
      where: { id: payment.id },
      data: { status: "PAID", providerPaymentId: event.providerPaymentId, paidAt: new Date() },
    });
    await audit(
      tx,
      actor,
      "funding.paid",
      "FundingPayment",
      payment.id,
      { status: payment.status },
      { status: "PAID" },
    );
    if (c.status === "PENDING_FUNDING" || c.status === "DRAFT") {
      if (c.status === "DRAFT") await transitionCampaign(tx, c.id, "PENDING_FUNDING", systemActor);
      await transitionCampaign(tx, c.id, "ACTIVE", actor, "Funding confirmed");
      await notifyOrgMembers(
        tx,
        c.organizationId,
        "CAMPAIGN_ACTIVE",
        { campaign: c.title },
        `/funder/campaigns/${c.id}`,
      );
    }
    return;
  }
  if (event.type === "funding.failed") {
    const payment = await tx.fundingPayment.findUnique({ where: { providerOrderId: event.providerOrderId } });
    if (!payment || payment.status !== "CREATED") return;
    await tx.fundingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
    await audit(tx, actor, "funding.failed", "FundingPayment", payment.id, undefined, {
      reason: event.reason,
    });
    return;
  }
  if (event.type === "payout.status") {
    await applyPayoutStatus(tx, event.providerPayoutId, event.status, event.failureReason, actor);
  }
}
