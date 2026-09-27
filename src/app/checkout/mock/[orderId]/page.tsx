import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { handlePaymentWebhook } from "@/domain/funding";
import { env } from "@/env";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { requirePageUser, requireOrgMember, requireUser } from "@/lib/session";
import { MockPaymentProvider, MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/payments/mock";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mock checkout" };

/** Development stand-in for Razorpay Checkout (UPI Intent / QR). Paying sends a signed mock webhook. */
async function pay(form: FormData) {
  "use server";
  const user = await requireUser();
  const orderId = String(form.get("orderId"));
  const outcome = String(form.get("outcome"));
  const payment = await db.fundingPayment.findUniqueOrThrow({
    where: { providerOrderId: orderId },
    include: { campaign: true },
  });
  await requireOrgMember(user.id, payment.campaign.organizationId, user.roles.includes("ADMIN"));
  const e = env();
  const body = JSON.stringify(
    outcome === "success"
      ? {
          type: "funding.paid",
          eventId: `evt_${randomUUID()}`,
          providerOrderId: orderId,
          providerPaymentId: `pay_mock_${randomUUID().slice(0, 12)}`,
          amountPaise: payment.amountPaise.toString(),
        }
      : {
          type: "funding.failed",
          eventId: `evt_${randomUUID()}`,
          providerOrderId: orderId,
          reason: "Mock: payment declined",
        },
  );
  // Same code path as a real provider callback (signature check + idempotent processing).
  await handlePaymentWebhook(new MockPaymentProvider(e.MOCK_WEBHOOK_SECRET, e.APP_URL), {
    rawBody: body,
    headers: new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, e.MOCK_WEBHOOK_SECRET) }),
  });
  redirect(`/funder/campaigns/${payment.campaignId}?funded=${outcome === "success" ? 1 : 0}`);
}

export default async function MockCheckout({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  await requirePageUser();
  const payment = await db.fundingPayment.findUnique({
    where: { providerOrderId: orderId },
    include: { campaign: true },
  });
  if (!payment || payment.provider !== "mock") notFound();
  return (
    <div className="mx-auto max-w-md">
      <Card className="p-7">
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-2xl">Checkout</h1>
          <Badge tone="warn">mock provider</Badge>
        </div>
        <p className="text-muted mt-1 text-sm">{payment.campaign.title}</p>
        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Campaign budget</dt>
            <dd className="tabular">{formatINR(payment.budgetPaise)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Platform fee</dt>
            <dd className="tabular">{formatINR(payment.feePaise)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">GST on fee</dt>
            <dd className="tabular">{formatINR(payment.gstPaise)}</dd>
          </div>
          <div className="border-border flex justify-between border-t pt-2 text-base">
            <dt>Total</dt>
            <dd className="tabular font-serif text-xl">{formatINR(payment.amountPaise)}</dd>
          </div>
        </dl>
        <div className="border-border text-muted mt-6 grid h-40 place-items-center rounded-xl border border-dashed text-center text-xs">
          UPI QR / Intent would appear here
          <br />
          (UPI Collect is being deprecated by NPCI)
        </div>
        {payment.status === "PAID" ? (
          <p className="text-good mt-6 text-sm">Already paid.</p>
        ) : (
          <form action={pay} className="mt-6 grid grid-cols-2 gap-2">
            <input type="hidden" name="orderId" value={orderId} />
            <Button name="outcome" value="failure" variant="secondary">
              Decline
            </Button>
            <Button name="outcome" value="success" data-testid="mock-pay">
              Pay {formatINR(payment.amountPaise)}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
