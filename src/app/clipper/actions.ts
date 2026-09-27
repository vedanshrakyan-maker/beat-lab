"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, str, type ActionState } from "@/lib/actions";
import { actorFor, recordFingerprint, requireUser } from "@/lib/session";
import { requestWithdrawal, savePayoutProfile } from "@/domain/payouts";
import { addManualEvidence } from "@/domain/review";
import { checkBioVerification, connectMockAccount, startBioVerification } from "@/domain/social-accounts";

const platformSchema = z.enum(["INSTAGRAM", "YOUTUBE"]);

export async function connectMockAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    const platform = platformSchema.parse(str(form, "platform"));
    const account = await connectMockAccount(user.id, platform, str(form, "handle"), await actorFor(user));
    revalidatePath("/clipper/accounts");
    return {
      ok: true,
      message: `Connected @${account.handle}${account.status === "VERIFIED" ? " — verified" : ""}.`,
    };
  });
}

export async function startBioAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    const account = await startBioVerification(user.id, "YOUTUBE", str(form, "handle"), await actorFor(user));
    revalidatePath("/clipper/accounts");
    return {
      ok: true,
      message: `Add ${account.verificationCode} to your channel description, then press "Check code".`,
    };
  });
}

export async function checkBioAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    await checkBioVerification(str(form, "accountId"), user.id, await actorFor(user));
    revalidatePath("/clipper/accounts");
    return { ok: true, message: "Verified!" };
  });
}

export async function payoutProfileAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    await savePayoutProfile(
      user.id,
      { legalName: str(form, "legalName"), upiId: str(form, "upiId"), pan: str(form, "pan") },
      await actorFor(user),
    );
    await recordFingerprint(user.id);
    revalidatePath("/clipper/accounts");
    return { ok: true, message: "Saved. Your UPI ID and PAN are encrypted and shown masked." };
  });
}

export async function withdrawAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    await recordFingerprint(user.id);
    const key = str(form, "requestKey") || randomUUID();
    const payout = await requestWithdrawal(user.id, key, await actorFor(user));
    revalidatePath("/clipper/wallet");
    return {
      ok: true,
      message: `Withdrawal requested. It'll be sent in the next payout batch (TDS ${payout.tdsPaise > 0n ? "withheld" : "not applicable"}).`,
    };
  });
}

export async function uploadEvidenceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a screen recording to upload" };
    const submissionId = str(form, "submissionId");
    await addManualEvidence(
      submissionId,
      user.id,
      { name: file.name, type: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
      str(form, "note") || undefined,
      await actorFor(user),
    );
    revalidatePath(`/clipper/submissions/${submissionId}`);
    return { ok: true, message: "Uploaded. An admin will verify your insights shortly." };
  });
}
