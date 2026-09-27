import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@/lib/crypto";
import type {
  CreateFundingOrderInput,
  CreatePayoutInput,
  FundingOrder,
  PaymentProvider,
  PaymentWebhookEvent,
  PayoutResult,
  PayoutStatusResult,
  WebhookRequest,
} from "@/payments/types";

/**
 * Default payment provider in development and tests. Deterministic:
 * - Funding: returns a mock checkout URL; the checkout page posts a signed webhook.
 * - Payouts: succeed, unless the UPI ID contains "fail" (to demo failures and reversals).
 * The same idempotency key always returns the same payout id (like RazorpayX).
 */
export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export function signMockWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  constructor(
    private readonly webhookSecret: string,
    private readonly appUrl: string,
  ) {}

  async createFundingOrder(input: CreateFundingOrderInput): Promise<FundingOrder> {
    return this.checkoutFor(`order_mock_${sha256Hex(input.receipt).slice(0, 14)}`, input.amountPaise);
  }

  checkoutFor(providerOrderId: string, amountPaise: bigint): FundingOrder {
    return {
      provider: this.name,
      providerOrderId,
      amountPaise,
      checkout: { kind: "redirect", url: `${this.appUrl}/checkout/mock/${providerOrderId}` },
    };
  }

  verifyWebhookSignature(req: WebhookRequest): boolean {
    const given = req.headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    const expected = signMockWebhook(req.rawBody, this.webhookSecret);
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  parseWebhook(req: WebhookRequest): PaymentWebhookEvent {
    const body = JSON.parse(req.rawBody) as Record<string, string>;
    if (body.type === "funding.paid") {
      return {
        type: "funding.paid",
        eventId: body.eventId!,
        providerOrderId: body.providerOrderId!,
        providerPaymentId: body.providerPaymentId!,
        amountPaise: BigInt(body.amountPaise!),
      };
    }
    if (body.type === "funding.failed") {
      return {
        type: "funding.failed",
        eventId: body.eventId!,
        providerOrderId: body.providerOrderId!,
        reason: body.reason ?? "failed",
      };
    }
    if (body.type === "payout.status") {
      return {
        type: "payout.status",
        eventId: body.eventId!,
        providerPayoutId: body.providerPayoutId!,
        status: body.status as "PAID" | "FAILED" | "REVERSED" | "PROCESSING",
        failureReason: body.failureReason,
      };
    }
    return { type: "ignored", eventId: body.eventId ?? "unknown" };
  }

  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    // The outcome is encoded in the id so any process (web or worker) can resolve it.
    const outcome = input.upiId.toLowerCase().includes("fail") ? "fail_" : "";
    return {
      providerPayoutId: `pout_mock_${outcome}${sha256Hex(input.idempotencyKey).slice(0, 14)}`,
      status: "PROCESSING",
      contactId: input.contactId ?? `cont_mock_${sha256Hex(input.upiId).slice(0, 10)}`,
      fundAccountId: input.fundAccountId ?? `fa_mock_${sha256Hex(input.upiId).slice(0, 10)}`,
    };
  }

  /** Mock payouts settle on the first status check. UPI IDs containing "fail" fail. */
  async getPayoutStatus(providerPayoutId: string): Promise<PayoutStatusResult> {
    if (providerPayoutId.startsWith("pout_mock_fail_")) {
      return { status: "FAILED", failureReason: "Mock: beneficiary VPA is invalid" };
    }
    return { status: "PAID" };
  }
}
