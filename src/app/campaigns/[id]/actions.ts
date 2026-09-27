"use server";

import { revalidatePath } from "next/cache";
import { runAction, str, type ActionState } from "@/lib/actions";
import { actorFor, recordFingerprint, requireUser } from "@/lib/session";
import { joinCampaign, submitPost } from "@/domain/submissions";

export async function joinAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    const campaignId = str(form, "campaignId");
    await joinCampaign(user.id, campaignId, await actorFor(user));
    await recordFingerprint(user.id);
    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true, message: "You're in. Post your clip, then paste the link below." };
  });
}

export async function submitAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser("CLIPPER");
    await recordFingerprint(user.id);
    const result = await submitPost(
      user.id,
      {
        campaignId: str(form, "campaignId"),
        socialAccountId: str(form, "socialAccountId"),
        postUrl: str(form, "postUrl"),
        mockScenario: str(form, "mockScenario") || undefined,
      },
      await actorFor(user),
    );
    revalidatePath("/clipper/submissions");
    return {
      ok: result.outcome !== "REJECTED",
      message: result.outcome !== "REJECTED" ? result.message : undefined,
      error: result.outcome === "REJECTED" ? `Rejected: ${result.message}` : undefined,
      data: { checks: result.checks, submissionId: result.submission.id },
    };
  });
}
