import type { Payout, PayoutStatus } from "@prisma/client";
import { z } from "zod";
import { audit, systemActor, type Actor } from "@/lib/audit";
import { blindIndex, decrypt, encrypt, maskPan, maskUpi, PAN_REGEX, UPI_REGEX } from "@/lib/crypto";
import { db, type DbOrTx } from "@/lib/db";
import { formatINR, toPaise, type Paise } from "@/lib/money";
import { getSetting } from "@/lib/settings";
import { acct, balance, credit, debit, post } from "@/ledger/ledger";
import { notify } from "@/domain/notifications";
import { tdsForPayout } from "@/domain/tax";
import { getPaymentProvider } from "@/payments";
import type { PaymentProvider, ProviderPayoutStatus } from "@/payments/types";

/**
 * Payouts: clipper withdrawal requests -> admin-approved PayoutBatch -> provider (UPI) with an
 * idempotency key -> webhook / status sync. Every step posts balanced ledger entries.
 *
 *   request:  Dr clipper_payable (gross)  Cr tds_payable (tds)  Cr payout_clearing (net)
 *   paid:     Dr payout_clearing (net)    Cr funder_cash_in (net)
 *   failed:   reverse the request entries (money back in the wallet)
 */

export class PayoutError extends Error {}

// ---------------------------------------------------------------------------
// Payout profile (UPI + PAN, encrypted at rest)
// ---------------------------------------------------------------------------

export const payoutProfileSchema = z.object({
  legalName: z.string().trim().min(3, "Enter your name as on PAN").max(120),
  upiId: z.string().trim().regex(UPI_REGEX, "Enter a valid UPI ID, e.g. name@okicici"),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN_REGEX, "PAN looks like ABCDE1234F")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function savePayoutProfile(
  userId: string,
  raw: z.input<typeof payoutProfileSchema>,
  actor: Actor,
) {
  const input = payoutProfileSchema.parse(raw);
  const upi = input.upiId.toLowerCase();
  const data = {
    legalName: input.legalName,
    encryptedUpiId: encrypt(upi),
    maskedUpiId: maskUpi(upi),
    upiHash: blindIndex(upi),
    // v0.1: PAN "verification" is format-only in the mock. Production: verify via a PAN
    // verification API and match the legal name (docs/COMPLIANCE.md).
    ...(input.pan
      ? {
          encryptedPan: encrypt(input.pan),
          maskedPan: maskPan(input.pan),
          panHash: blindIndex(input.pan),
          panVerified: true,
        }
      : {}),
    accountVerificationStatus: "VERIFIED",
    // New UPI -> new RazorpayX fund account.
    providerFundAccountId: null,
  };
  return db.$transaction(async (tx) => {
    const before = await tx.payoutProfile.findUnique({ where: { userId } });
    const profile = await tx.payoutProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    // Audit masked values only: never log PAN or UPI plaintext/ciphertext.
    await audit(
      tx,
      actor,
      "payout_profile.save",
      "PayoutProfile",
      profile.id,
      before ? { maskedUpiId: before.maskedUpiId, maskedPan: before.maskedPan } : undefined,
      { maskedUpiId: profile.maskedUpiId, maskedPan: profile.maskedPan, panVerified: profile.panVerified },
    );
    return profile;
  });
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export interface WalletSummary {
  payablePaise: Paise;
  pendingPaise: Paise;
  inFlightPaise: Paise;
  paidOutNetPaise: Paise;
  tdsWithheldPaise: Paise;
  minWithdrawalPaise: Paise;
}

export async function walletSummary(userId: string, client: DbOrTx = db): Promise<WalletSummary> {
  const [payable, pending, inFlight, paid, settings] = await Promise.all([
    balance(client, acct.clipperPayable(userId)),
    client.submission.aggregate({
      where: { clipperId: userId, status: { in: ["APPROVED", "TRACKING", "LOCKED", "HELD", "FLAGGED"] } },
      _sum: { earnedPaise: true },
    }),
    client.payout.aggregate({
      where: { userId, status: { in: ["PENDING", "APPROVED", "PROCESSING"] } },
      _sum: { netPaise: true },
    }),
    client.payout.aggregate({ where: { userId, status: "PAID" }, _sum: { netPaise: true, tdsPaise: true } }),
    getSetting("payouts", client),
  ]);
  return {
    payablePaise: payable,
    pendingPaise: pending._sum.earnedPaise ?? 0n,
    inFlightPaise: inFlight._sum.netPaise ?? 0n,
    paidOutNetPaise: paid._sum.netPaise ?? 0n,
    tdsWithheldPaise: paid._sum.tdsPaise ?? 0n,
    minWithdrawalPaise: toPaise(settings.minWithdrawalPaise),
  };
}

/**
 * Withdraw the full payable balance (partial withdrawals are a later feature).
 * `requestKey` makes double-submits idempotent.
 */
export async function requestWithdrawal(
  userId: string,
  requestKey: string,
  actor: Actor,
  now = new Date(),
): Promise<Payout> {
  if (!/^[\w-]{8,64}$/.test(requestKey)) throw new PayoutError("Invalid request key");
  const idempotencyKey = `payout:${userId}:${requestKey}`;
  const existing = await db.payout.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  return db.$transaction(
    async (tx) => {
      // Serialize withdrawals per user.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { payoutProfile: true },
      });
      if (user.status !== "ACTIVE") throw new PayoutError("Your account is not active");
      if (user.flaggedAt)
        throw new PayoutError(
          `Withdrawals are paused while your account is under review: ${user.flagReason ?? "flagged"}`,
        );
      const profile = user.payoutProfile;
      if (!profile) throw new PayoutError("Add your UPI ID and PAN before withdrawing");
      const open = await tx.payout.count({
        where: { userId, status: { in: ["PENDING", "APPROVED", "PROCESSING"] } },
      });
      if (open > 0) throw new PayoutError("You already have a withdrawal in progress");

      const gross = await balance(tx, acct.clipperPayable(userId));
      const { minWithdrawalPaise } = await getSetting("payouts", tx);
      if (gross < toPaise(minWithdrawalPaise)) {
        throw new PayoutError(
          `Minimum withdrawal is ${formatINR(toPaise(minWithdrawalPaise))}; your balance is ${formatINR(gross)}`,
        );
      }
      const tds = await tdsForPayout(tx, userId, gross, now, profile.panVerified);
      const net = gross - tds.tdsPaise;

      const payout = await tx.payout.create({
        data: {
          userId,
          grossPaise: gross,
          tdsPaise: tds.tdsPaise,
          netPaise: net,
          taxRuleId: tds.ruleId,
          tdsExplanation: tds.explanation,
          provider: getPaymentProvider().name,
          idempotencyKey,
          maskedUpiId: profile.maskedUpiId,
          requestedAt: now,
        },
      });
      await post(tx, {
        idempotencyKey: `payout_request:${payout.id}`,
        kind: "PAYOUT_REQUEST",
        description: `Withdrawal ${formatINR(gross)} (TDS ${formatINR(tds.tdsPaise)})`,
        payoutId: payout.id,
        userId,
        entries: [
          debit(acct.clipperPayable(userId), gross),
          credit(acct.tdsPayable(), tds.tdsPaise),
          credit(acct.payoutClearing(), net),
        ],
      });
      await tx.submission.updateMany({
        where: { clipperId: userId, status: "PAYABLE", payoutId: null },
        data: { payoutId: payout.id },
      });
      await audit(tx, actor, "payout.request", "Payout", payout.id, undefined, payout);
      return payout;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Batches (admin)
// ---------------------------------------------------------------------------

export async function createPayoutBatch(adminId: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const pending = await tx.payout.findMany({
      where: { status: "PENDING", batchId: null },
      include: { user: true },
    });
    const eligible = pending.filter((p) => p.user.status === "ACTIVE" && !p.user.flaggedAt);
    if (eligible.length === 0) throw new PayoutError("No pending withdrawals to batch");
    const batch = await tx.payoutBatch.create({
      data: {
        createdById: adminId,
        totalGrossPaise: eligible.reduce((s, p) => s + p.grossPaise, 0n),
        totalTdsPaise: eligible.reduce((s, p) => s + p.tdsPaise, 0n),
        totalNetPaise: eligible.reduce((s, p) => s + p.netPaise, 0n),
        payoutCount: eligible.length,
      },
    });
    await tx.payout.updateMany({
      where: { id: { in: eligible.map((p) => p.id) } },
      data: { batchId: batch.id },
    });
    await audit(tx, actor, "payout_batch.create", "PayoutBatch", batch.id, undefined, batch);
    return batch;
  });
}

/** Approve a batch and send each payout to the provider with its idempotency key. */
export async function approvePayoutBatch(
  batchId: string,
  adminId: string,
  actor: Actor,
  provider: PaymentProvider = getPaymentProvider(),
) {
  await db.$transaction(async (tx) => {
    const batch = await tx.payoutBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.status !== "DRAFT") throw new PayoutError("Only draft batches can be approved");
    await tx.payoutBatch.update({
      where: { id: batchId },
      data: { status: "APPROVED", approvedById: adminId, approvedAt: new Date() },
    });
    const payouts = await tx.payout.findMany({ where: { batchId, status: "PENDING" } });
    for (const p of payouts) await setPayoutStatus(tx, p, "APPROVED", actor);
    await audit(
      tx,
      actor,
      "payout_batch.approve",
      "PayoutBatch",
      batchId,
      { status: batch.status },
      { status: "APPROVED" },
    );
  });
  await sendApprovedPayouts(batchId, provider);
}

/** Safe to retry: the provider de-duplicates on the payout's idempotency key. */
export async function sendApprovedPayouts(batchId: string, provider: PaymentProvider = getPaymentProvider()) {
  const payouts = await db.payout.findMany({
    where: { batchId, status: "APPROVED" },
    include: { user: { include: { payoutProfile: true } } },
  });
  for (const p of payouts) {
    const profile = p.user.payoutProfile;
    if (!profile) continue;
    try {
      const result = await provider.createPayout({
        idempotencyKey: p.idempotencyKey,
        upiId: decrypt(profile.encryptedUpiId),
        amountPaise: p.netPaise,
        legalName: profile.legalName,
        referenceId: p.id,
        narration: "ReelPay earnings",
        contactId: profile.providerContactId,
        fundAccountId: profile.providerFundAccountId,
      });
      await db.$transaction(async (tx) => {
        await tx.payoutProfile.update({
          where: { id: profile.id },
          data: {
            providerContactId: result.contactId ?? undefined,
            providerFundAccountId: result.fundAccountId ?? undefined,
          },
        });
        const fresh = await tx.payout.findUniqueOrThrow({ where: { id: p.id } });
        if (fresh.status !== "APPROVED") return;
        await tx.payout.update({
          where: { id: p.id },
          data: { providerPayoutId: result.providerPayoutId, processedAt: new Date() },
        });
        await setPayoutStatus(tx, fresh, "PROCESSING", systemActor);
      });
      if (result.status !== "PROCESSING") {
        await db.$transaction((tx) =>
          applyPayoutStatus(tx, result.providerPayoutId, result.status, result.failureReason, systemActor),
        );
      }
    } catch (e) {
      // Leave APPROVED; the next attempt re-sends with the same idempotency key.
      console.error(`[payouts] provider call failed for ${p.id}:`, e instanceof Error ? e.message : e);
    }
  }
  await db.payoutBatch.updateMany({
    where: { id: batchId, status: "APPROVED" },
    data: { status: "PROCESSING" },
  });
  await refreshBatchStatus(db, batchId);
}

export async function rejectPayout(payoutId: string, reason: string, actor: Actor) {
  if (reason.trim().length < 5) throw new PayoutError("Give a reason");
  await db.$transaction(async (tx) => {
    const p = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
    if (p.status !== "PENDING") throw new PayoutError("Only pending withdrawals can be rejected");
    await reverseRequest(tx, p, "REJECTED", reason, actor);
  });
}

async function setPayoutStatus(
  tx: DbOrTx,
  p: Pick<Payout, "id" | "status">,
  to: PayoutStatus,
  actor: Actor,
  extra: Record<string, unknown> = {},
) {
  await tx.payout.update({ where: { id: p.id }, data: { status: to, ...extra } });
  await audit(
    tx,
    actor,
    `payout.status.${to.toLowerCase()}`,
    "Payout",
    p.id,
    { status: p.status },
    { status: to, ...extra },
  );
}

async function reverseRequest(
  tx: DbOrTx,
  p: Payout,
  to: "FAILED" | "REVERSED" | "REJECTED",
  reason: string,
  actor: Actor,
) {
  const wasPaid = p.status === "PAID";
  await post(tx, {
    idempotencyKey: `payout_reversal:${p.id}`,
    kind: "PAYOUT_FAILED",
    description: `Payout ${to.toLowerCase()}: ${reason}`,
    payoutId: p.id,
    userId: p.userId,
    entries: [
      // If the money had left (PAID), it came back to cash; otherwise it leaves clearing.
      wasPaid ? debit(acct.funderCashIn(), p.netPaise) : debit(acct.payoutClearing(), p.netPaise),
      debit(acct.tdsPayable(), p.tdsPaise),
      credit(acct.clipperPayable(p.userId), p.grossPaise),
    ],
  });
  await setPayoutStatus(tx, p, to, actor, { failureReason: reason });
  await tx.submission.updateMany({
    where: { payoutId: p.id },
    data: { payoutId: null, status: "PAYABLE", paidAt: null },
  });
  await notify(tx, p.userId, "PAYOUT_FAILED", { amount: formatINR(p.grossPaise), reason }, "/clipper/wallet");
}

/** Apply a provider status (from a webhook or a status sync). Idempotent. */
export async function applyPayoutStatus(
  tx: DbOrTx,
  providerPayoutId: string,
  status: ProviderPayoutStatus,
  failureReason: string | undefined,
  actor: Actor,
) {
  await tx.$queryRaw`SELECT id FROM "Payout" WHERE "providerPayoutId" = ${providerPayoutId} FOR UPDATE`;
  const p = await tx.payout.findFirst({ where: { providerPayoutId } });
  if (!p) throw new PayoutError(`Unknown provider payout ${providerPayoutId}`);
  if (status === "PROCESSING" || p.status === status) return;

  if (status === "PAID") {
    if (p.status !== "PROCESSING" && p.status !== "APPROVED") return;
    const now = new Date();
    await post(tx, {
      idempotencyKey: `payout_paid:${p.id}`,
      kind: "PAYOUT_PAID",
      description: `Payout sent to ${p.maskedUpiId}`,
      payoutId: p.id,
      userId: p.userId,
      entries: [debit(acct.payoutClearing(), p.netPaise), credit(acct.funderCashIn(), p.netPaise)],
    });
    await setPayoutStatus(tx, p, "PAID", actor, { paidAt: now });
    const covered = await tx.submission.findMany({ where: { payoutId: p.id, status: "PAYABLE" } });
    for (const s of covered) {
      await tx.submission.update({ where: { id: s.id }, data: { status: "PAID", paidAt: now } });
      await audit(
        tx,
        actor,
        "submission.status.paid",
        "Submission",
        s.id,
        { status: "PAYABLE" },
        { status: "PAID", payoutId: p.id },
      );
    }
    await notify(
      tx,
      p.userId,
      "PAYOUT_SENT",
      { amount: formatINR(p.netPaise), upi: p.maskedUpiId, tds: formatINR(p.tdsPaise) },
      "/clipper/wallet",
    );
  } else if (status === "FAILED" || status === "REVERSED") {
    if (p.status === "FAILED" || p.status === "REVERSED" || p.status === "REJECTED") return;
    await reverseRequest(tx, p, status, failureReason ?? "Provider reported failure", actor);
  }
  if (p.batchId) await refreshBatchStatus(tx, p.batchId);
}

async function refreshBatchStatus(tx: DbOrTx, batchId: string) {
  const payouts = await tx.payout.findMany({ where: { batchId }, select: { status: true } });
  if (payouts.length === 0 || payouts.some((p) => ["PENDING", "APPROVED", "PROCESSING"].includes(p.status)))
    return;
  const failed = payouts.some((p) => p.status !== "PAID");
  await tx.payoutBatch.update({
    where: { id: batchId },
    data: { status: failed ? "PARTIALLY_FAILED" : "COMPLETED", completedAt: new Date() },
  });
}

/** Worker job: poll the provider for payouts still processing (webhooks can be missed). */
export async function syncProcessingPayouts(
  provider: PaymentProvider = getPaymentProvider(),
): Promise<number> {
  const processing = await db.payout.findMany({
    where: { status: "PROCESSING", providerPayoutId: { not: null } },
    take: 200,
  });
  for (const p of processing) {
    const s = await provider.getPayoutStatus(p.providerPayoutId!);
    if (s.status !== "PROCESSING") {
      await db.$transaction((tx) =>
        applyPayoutStatus(tx, p.providerPayoutId!, s.status, s.failureReason, {
          id: null,
          label: `sync:${provider.name}`,
        }),
      );
    }
  }
  return processing.length;
}
