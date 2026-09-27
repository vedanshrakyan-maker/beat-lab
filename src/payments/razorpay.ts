import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreateFundingOrderInput,
  CreatePayoutInput,
  FundingOrder,
  PaymentProvider,
  PaymentWebhookEvent,
  PayoutResult,
  PayoutStatusResult,
  ProviderPayoutStatus,
  WebhookRequest,
} from "@/payments/types";

/**
 * RazorpayProvider SKELETON (enable with PAYMENTS_PROVIDER=razorpay and TEST keys).
 * - Funding: Razorpay Orders API + Checkout. Offer UPI Intent / QR, NOT UPI Collect
 *   (NPCI is deprecating collect requests).
 * - Payouts: RazorpayX Payouts to a UPI VPA fund account, with X-Payout-Idempotency.
 * - Webhooks: HMAC-SHA256 of the raw body with the webhook secret (X-Razorpay-Signature).
 * Not exercised in tests or dev. See docs/PLATFORMS.md and docs/COMPLIANCE.md.
 */

const API = "https://api.razorpay.com/v1";
type FetchFn = typeof fetch;

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** RazorpayX current account number payouts are debited from. */
  accountNumber: string;
}

const PAYOUT_STATUS: Record<string, ProviderPayoutStatus> = {
  queued: "PROCESSING",
  pending: "PROCESSING",
  scheduled: "PROCESSING",
  processing: "PROCESSING",
  processed: "PAID",
  failed: "FAILED",
  rejected: "FAILED",
  cancelled: "FAILED",
  reversed: "REVERSED",
};

export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay" as const;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString("base64");
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T & { error?: { description?: string } };
    if (!res.ok)
      throw new Error(`Razorpay ${method} ${path} failed: ${json.error?.description ?? res.status}`);
    return json;
  }

  async createFundingOrder(input: CreateFundingOrderInput): Promise<FundingOrder> {
    const order = await this.request<{ id: string; amount: number }>("POST", "/orders", {
      amount: Number(input.amountPaise), // Razorpay amounts are integer paise
      currency: "INR",
      receipt: input.receipt,
      notes: { campaignId: input.campaignId, ...input.notes },
    });
    return this.checkoutFor(order.id, BigInt(order.amount));
  }

  checkoutFor(providerOrderId: string, amountPaise: bigint): FundingOrder {
    return {
      provider: this.name,
      providerOrderId,
      amountPaise,
      checkout: { kind: "razorpay_checkout", keyId: this.config.keyId, orderId: providerOrderId },
    };
  }

  verifyWebhookSignature(req: WebhookRequest): boolean {
    const given = req.headers.get("x-razorpay-signature") ?? "";
    const expected = createHmac("sha256", this.config.webhookSecret).update(req.rawBody).digest("hex");
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  parseWebhook(req: WebhookRequest): PaymentWebhookEvent {
    const body = JSON.parse(req.rawBody) as {
      event: string;
      payload?: {
        payment?: { entity: { id: string; order_id: string; amount: number; error_description?: string } };
        order?: { entity: { id: string } };
        payout?: { entity: { id: string; status: string; failure_reason?: string } };
      };
    };
    // Razorpay sends a unique x-razorpay-event-id header per event.
    const eventId = req.headers.get("x-razorpay-event-id") ?? `${body.event}:${Date.now()}`;
    const payment = body.payload?.payment?.entity;
    const payout = body.payload?.payout?.entity;
    if ((body.event === "order.paid" || body.event === "payment.captured") && payment) {
      return {
        type: "funding.paid",
        eventId,
        providerOrderId: payment.order_id,
        providerPaymentId: payment.id,
        amountPaise: BigInt(payment.amount),
      };
    }
    if (body.event === "payment.failed" && payment) {
      return {
        type: "funding.failed",
        eventId,
        providerOrderId: payment.order_id,
        reason: payment.error_description ?? "failed",
      };
    }
    if (body.event.startsWith("payout.") && payout) {
      return {
        type: "payout.status",
        eventId,
        providerPayoutId: payout.id,
        status: PAYOUT_STATUS[payout.status] ?? "PROCESSING",
        failureReason: payout.failure_reason,
      };
    }
    return { type: "ignored", eventId };
  }

  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    let contactId = input.contactId ?? undefined;
    let fundAccountId = input.fundAccountId ?? undefined;
    if (!contactId) {
      const contact = await this.request<{ id: string }>("POST", "/contacts", {
        name: input.legalName,
        type: "vendor",
        reference_id: input.referenceId,
      });
      contactId = contact.id;
    }
    if (!fundAccountId) {
      const fa = await this.request<{ id: string }>("POST", "/fund_accounts", {
        contact_id: contactId,
        account_type: "vpa",
        vpa: { address: input.upiId },
      });
      fundAccountId = fa.id;
    }
    const payout = await this.request<{ id: string; status: string; failure_reason?: string }>(
      "POST",
      "/payouts",
      {
        account_number: this.config.accountNumber,
        fund_account_id: fundAccountId,
        amount: Number(input.amountPaise),
        currency: "INR",
        mode: "UPI",
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: input.referenceId,
        narration: input.narration.slice(0, 30),
      },
      { "X-Payout-Idempotency": input.idempotencyKey },
    );
    return {
      providerPayoutId: payout.id,
      status: PAYOUT_STATUS[payout.status] ?? "PROCESSING",
      failureReason: payout.failure_reason,
      contactId,
      fundAccountId,
    };
  }

  async getPayoutStatus(providerPayoutId: string): Promise<PayoutStatusResult> {
    const payout = await this.request<{ status: string; failure_reason?: string }>(
      "GET",
      `/payouts/${providerPayoutId}`,
    );
    return { status: PAYOUT_STATUS[payout.status] ?? "PROCESSING", failureReason: payout.failure_reason };
  }
}
