import type { Paise } from "@/lib/money";

export interface CreateFundingOrderInput {
  /** Our FundingPayment id; used as the provider receipt and idempotency key. */
  receipt: string;
  amountPaise: Paise;
  campaignId: string;
  notes?: Record<string, string>;
}

export interface FundingOrder {
  provider: string;
  providerOrderId: string;
  amountPaise: Paise;
  /** Where to send the funder to pay (mock checkout page, or Razorpay Checkout params). */
  checkout: { kind: "redirect"; url: string } | { kind: "razorpay_checkout"; keyId: string; orderId: string };
}

export interface CreatePayoutInput {
  /** Required by RazorpayX Payouts (X-Payout-Idempotency). Reusing it must never pay twice. */
  idempotencyKey: string;
  upiId: string;
  amountPaise: Paise;
  legalName: string;
  referenceId: string;
  narration: string;
  /** Cached provider ids (RazorpayX contact / fund account) to avoid re-creating them. */
  contactId?: string | null;
  fundAccountId?: string | null;
}

export type ProviderPayoutStatus = "PROCESSING" | "PAID" | "FAILED" | "REVERSED";

export interface PayoutResult {
  providerPayoutId: string;
  status: ProviderPayoutStatus;
  failureReason?: string;
  contactId?: string;
  fundAccountId?: string;
}

export interface PayoutStatusResult {
  status: ProviderPayoutStatus;
  failureReason?: string;
}

/** Normalized webhook events. */
export type PaymentWebhookEvent =
  | {
      type: "funding.paid";
      eventId: string;
      providerOrderId: string;
      providerPaymentId: string;
      amountPaise: Paise;
    }
  | { type: "funding.failed"; eventId: string; providerOrderId: string; reason: string }
  | {
      type: "payout.status";
      eventId: string;
      providerPayoutId: string;
      status: ProviderPayoutStatus;
      failureReason?: string;
    }
  | { type: "ignored"; eventId: string };

export interface WebhookRequest {
  rawBody: string;
  headers: Headers;
}

export interface PaymentProvider {
  name: "mock" | "razorpay";
  createFundingOrder(input: CreateFundingOrderInput): Promise<FundingOrder>;
  /** Checkout details for an order that already exists (re-opening an unpaid order). */
  checkoutFor(providerOrderId: string, amountPaise: Paise): FundingOrder;
  verifyWebhookSignature(req: WebhookRequest): boolean;
  parseWebhook(req: WebhookRequest): PaymentWebhookEvent;
  createPayout(input: CreatePayoutInput): Promise<PayoutResult>;
  getPayoutStatus(providerPayoutId: string): Promise<PayoutStatusResult>;
}
