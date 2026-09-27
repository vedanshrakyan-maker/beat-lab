"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { runAction, str, type ActionState } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { parseSetting, settingRegistry, type SettingKey } from "@/lib/settings";
import { actorFor, requireUser } from "@/lib/session";
import { recordRefund } from "@/domain/campaigns";
import { fastForwardCampaign, fastForwardSubmission } from "@/domain/devtools";
import { approvePayoutBatch, createPayoutBatch, rejectPayout, syncProcessingPayouts } from "@/domain/payouts";
import {
  adminVoidSubmission,
  approveSubmission,
  enterManualMetrics,
  rejectSubmission,
} from "@/domain/review";
import { upsertTaxRule } from "@/domain/tax";
import { recordLedgerVerification } from "@/ledger/verify";

async function admin() {
  const user = await requireUser("ADMIN");
  return { user, actor: await actorFor(user) };
}

export async function reviewAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user, actor } = await admin();
    const id = str(form, "submissionId");
    const decision = str(form, "decision");
    const reason = str(form, "reason");
    if (decision === "approve") await approveSubmission(id, user.id, reason, actor);
    else if (decision === "reject") await rejectSubmission(id, user.id, reason, actor);
    else if (decision === "void") await adminVoidSubmission(id, user.id, reason, actor);
    else return { error: "Unknown decision" };
    revalidatePath("/admin/review");
    revalidatePath(`/admin/review/${id}`);
    return { ok: true, message: `Decision recorded: ${decision}.` };
  });
}

export async function manualMetricsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user, actor } = await admin();
    const id = str(form, "submissionId");
    const opt = (k: string) => (str(form, k) === "" ? null : str(form, k));
    await enterManualMetrics(
      id,
      user.id,
      {
        views: str(form, "views"),
        likes: str(form, "likes") || "0",
        comments: str(form, "comments") || "0",
        shares: str(form, "shares") || "0",
        reach: opt("reach"),
        saves: opt("saves"),
        note: str(form, "note") || undefined,
      },
      actor,
    );
    revalidatePath(`/admin/review/${id}`);
    return { ok: true, message: "Manual metrics saved (source MANUAL, stricter fraud bands)." };
  });
}

export async function fastForwardAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await admin();
    const hours = Number(str(form, "hours"));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 60)
      return { error: "Hours must be between 1 and 1440" };
    const submissionId = str(form, "submissionId");
    const campaignId = str(form, "campaignId");
    const steps = submissionId
      ? await fastForwardSubmission(submissionId, hours, actor)
      : await fastForwardCampaign(campaignId, hours, actor);
    revalidatePath("/admin", "layout");
    return { ok: true, message: `Fast-forwarded ${hours}h: ran ${steps} lifecycle step(s).` };
  });
}

export async function payoutBatchAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user, actor } = await admin();
    const op = str(form, "op");
    if (op === "create") {
      const b = await createPayoutBatch(user.id, actor);
      revalidatePath("/admin/payouts");
      return { ok: true, message: `Batch created with ${b.payoutCount} payouts.` };
    }
    if (op === "approve") {
      await approvePayoutBatch(str(form, "batchId"), user.id, actor);
      revalidatePath("/admin/payouts");
      return { ok: true, message: "Batch approved and sent to the payment provider." };
    }
    if (op === "sync") {
      const n = await syncProcessingPayouts();
      revalidatePath("/admin/payouts");
      return { ok: true, message: `Checked ${n} processing payouts.` };
    }
    if (op === "reject") {
      await rejectPayout(str(form, "payoutId"), str(form, "reason"), actor);
      revalidatePath("/admin/payouts");
      return { ok: true, message: "Withdrawal rejected; money returned to the wallet." };
    }
    return { error: "Unknown operation" };
  });
}

export async function settingAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user, actor } = await admin();
    const key = str(form, "key") as SettingKey;
    if (!(key in settingRegistry)) return { error: "Unknown setting" };
    let json: unknown;
    try {
      json = JSON.parse(str(form, "value"));
    } catch {
      return { error: "Not valid JSON" };
    }
    const value = parseSetting(key, json) as Prisma.InputJsonValue;
    await db.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key } });
      await tx.setting.upsert({
        where: { key },
        create: { key, value, updatedById: user.id },
        update: { value, updatedById: user.id },
      });
      await audit(tx, actor, "setting.update", "Setting", key, before?.value, value);
    });
    revalidatePath("/admin/settings");
    return { ok: true, message: `Saved “${settingRegistry[key].label}”.` };
  });
}

export async function taxRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await admin();
    const paise = (k: string) => (str(form, k) === "" ? null : str(form, k));
    await upsertTaxRule(
      str(form, "id") || null,
      {
        name: str(form, "name"),
        appliesTo: "CLIPPER_PAYOUT",
        ratePctBps: str(form, "ratePctBps"),
        rateWithoutPanBps: str(form, "rateWithoutPanBps"),
        annualThresholdPaise: str(form, "annualThresholdPaise"),
        perTransactionThresholdPaise: paise("perTransactionThresholdPaise"),
        sectionLabel: str(form, "sectionLabel"),
        notes: str(form, "notes") || undefined,
        effectiveFrom: str(form, "effectiveFrom"),
        effectiveTo: str(form, "effectiveTo") || null,
        active: str(form, "active") === "on",
      },
      actor,
    );
    revalidatePath("/admin/settings");
    return { ok: true, message: "Tax rule saved." };
  });
}

export async function refundAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await admin();
    const amount = await recordRefund(str(form, "organizationId"), actor);
    revalidatePath("/admin/campaigns");
    return { ok: true, message: amount > 0n ? "Refund recorded in the ledger." : "Nothing to refund." };
  });
}

export async function verifyLedgerAction(): Promise<ActionState> {
  return runAction(async () => {
    await admin();
    const r = await recordLedgerVerification();
    revalidatePath("/admin");
    return r.ok
      ? { ok: true, message: "Ledger verified: all checks pass." }
      : { error: "Ledger verification FAILED — see the health panel." };
  });
}

export async function userFlagAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { actor } = await admin();
    const userId = str(form, "userId");
    const op = str(form, "op");
    await db.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const data =
        op === "clear"
          ? { flaggedAt: null, flagReason: null }
          : op === "suspend"
            ? { status: "SUSPENDED" as const }
            : op === "activate"
              ? { status: "ACTIVE" as const }
              : null;
      if (!data) throw new Error("Unknown op");
      const after = await tx.user.update({ where: { id: userId }, data });
      await audit(
        tx,
        actor,
        `user.${op}`,
        "User",
        userId,
        { status: before.status, flaggedAt: before.flaggedAt },
        { status: after.status, flaggedAt: after.flaggedAt },
      );
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Updated." };
  });
}
