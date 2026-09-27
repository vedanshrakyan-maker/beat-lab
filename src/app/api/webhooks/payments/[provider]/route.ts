import { NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/domain/funding";
import { getPaymentProvider } from "@/payments";

/**
 * Payment provider webhooks. The raw body is used for signature verification; processing is
 * idempotent per event id, so provider retries are safe.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: name } = await params;
  if (name !== "mock" && name !== "razorpay")
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const provider = getPaymentProvider(name);
  const rawBody = await req.text();
  try {
    const outcome = await handlePaymentWebhook(provider, { rawBody, headers: req.headers });
    if (outcome === "invalid_signature")
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    return NextResponse.json({ outcome });
  } catch (e) {
    console.error(`[webhook:${name}]`, e instanceof Error ? e.message : e);
    // 500 so the provider retries later.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
