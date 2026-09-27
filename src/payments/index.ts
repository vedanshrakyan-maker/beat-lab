import { env } from "@/env";
import { MockPaymentProvider } from "@/payments/mock";
import { RazorpayProvider } from "@/payments/razorpay";
import type { PaymentProvider } from "@/payments/types";

export function getPaymentProvider(name?: string): PaymentProvider {
  const e = env();
  const which = name ?? e.PAYMENTS_PROVIDER;
  if (which === "razorpay") {
    return new RazorpayProvider({
      keyId: e.RAZORPAY_KEY_ID ?? "",
      keySecret: e.RAZORPAY_KEY_SECRET ?? "",
      webhookSecret: e.RAZORPAY_WEBHOOK_SECRET ?? "",
      accountNumber: e.RAZORPAYX_ACCOUNT_NUMBER ?? "",
    });
  }
  return new MockPaymentProvider(e.MOCK_WEBHOOK_SECRET, e.APP_URL);
}
