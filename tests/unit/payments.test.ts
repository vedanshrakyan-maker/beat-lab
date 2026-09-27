import { describe, expect, it } from "vitest";
import { MockPaymentProvider, MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/payments/mock";
import { RazorpayProvider } from "@/payments/razorpay";
import { createHmac } from "node:crypto";

describe("MockPaymentProvider", () => {
  const p = new MockPaymentProvider("secret", "http://localhost:3000");

  it("verifies webhook signatures", () => {
    const rawBody = JSON.stringify({ type: "funding.paid", eventId: "e1" });
    const good = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(rawBody, "secret") });
    const bad = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(rawBody, "wrong") });
    expect(p.verifyWebhookSignature({ rawBody, headers: good })).toBe(true);
    expect(p.verifyWebhookSignature({ rawBody, headers: bad })).toBe(false);
    expect(p.verifyWebhookSignature({ rawBody, headers: new Headers() })).toBe(false);
  });

  it("returns the same payout for the same idempotency key", async () => {
    const input = {
      idempotencyKey: "k1",
      upiId: "a@ybl",
      amountPaise: 100n,
      legalName: "A",
      referenceId: "r",
      narration: "n",
    };
    expect((await p.createPayout(input)).providerPayoutId).toBe(
      (await p.createPayout(input)).providerPayoutId,
    );
    const failing = await p.createPayout({ ...input, idempotencyKey: "k2", upiId: "fail@ybl" });
    expect((await p.getPayoutStatus(failing.providerPayoutId)).status).toBe("FAILED");
  });
});

describe("RazorpayProvider (skeleton)", () => {
  const rp = new RazorpayProvider({ keyId: "k", keySecret: "s", webhookSecret: "whsec", accountNumber: "1" });
  it("verifies X-Razorpay-Signature and normalizes events", () => {
    const rawBody = JSON.stringify({
      event: "payout.processed",
      payload: { payout: { entity: { id: "pout_1", status: "processed" } } },
    });
    const sig = createHmac("sha256", "whsec").update(rawBody).digest("hex");
    const headers = new Headers({ "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1" });
    expect(rp.verifyWebhookSignature({ rawBody, headers })).toBe(true);
    expect(rp.parseWebhook({ rawBody, headers })).toEqual({
      type: "payout.status",
      eventId: "evt_1",
      providerPayoutId: "pout_1",
      status: "PAID",
      failureReason: undefined,
    });
  });
});
