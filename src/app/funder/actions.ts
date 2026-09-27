"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, str, type ActionState } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { parseRupeesToPaise } from "@/lib/money";
import { getSetting } from "@/lib/settings";
import { actorFor, requireOrgMember, requireUser } from "@/lib/session";
import { createCampaign, endCampaign, pauseCampaign, resumeCampaign } from "@/domain/campaigns";
import { startFunding } from "@/domain/funding";

const orgSchema = z.object({
  name: z.string().trim().min(2).max(120),
  billingEmail: z.string().trim().email(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, "GSTIN looks like 27ABCDE1234F1Z5")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function createOrgAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser();
    const data = orgSchema.parse({
      name: str(form, "name"),
      billingEmail: str(form, "billingEmail"),
      gstin: str(form, "gstin"),
    });
    await db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { ...data, members: { create: { userId: user.id, role: "OWNER" } } },
      });
      if (!user.roles.includes("FUNDER"))
        await tx.user.update({ where: { id: user.id }, data: { roles: { push: "FUNDER" } } });
      await audit(tx, await actorFor(user), "organization.create", "Organization", org.id, undefined, org);
    });
    revalidatePath("/funder");
    return { ok: true, message: "Organization created." };
  });
}

function money(form: FormData, key: string, required: boolean): bigint | null {
  const raw = str(form, key).trim();
  if (!raw) {
    if (required) throw new z.ZodError([{ code: "custom", path: [key], message: "Required", input: raw }]);
    return null;
  }
  const p = parseRupeesToPaise(raw);
  if (p === null)
    throw new z.ZodError([
      { code: "custom", path: [key], message: "Enter an amount in rupees, e.g. 25000 or 30.50", input: raw },
    ]);
  return p;
}

const list = (v: string) =>
  v
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export async function createCampaignAction(_: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const result = await runAction(async () => {
    const managed = str(form, "managed") === "1";
    const user = await requireUser(managed ? "ADMIN" : "FUNDER");
    const organizationId = str(form, "organizationId");
    await requireOrgMember(user.id, organizationId, managed && user.roles.includes("ADMIN"));
    const defaults = await getSetting("campaignDefaults");
    const date = (k: string) => (str(form, k) ? new Date(`${str(form, k)}T00:00:00+05:30`) : null);
    const campaign = await createCampaign(
      {
        organizationId,
        title: str(form, "title"),
        description: str(form, "description"),
        category: str(form, "category") || "General",
        type: str(form, "type") === "UGC" ? "UGC" : "CLIPPING",
        sourceContentUrls: list(str(form, "sourceContentUrls")),
        rules: {
          requiredHashtags: list(str(form, "requiredHashtags")),
          requiredMentions: list(str(form, "requiredMentions")),
          minDurationSec: str(form, "minDurationSec") ? Number(str(form, "minDurationSec")) : null,
          maxDurationSec: str(form, "maxDurationSec") ? Number(str(form, "maxDurationSec")) : null,
          languages: list(str(form, "languages")),
          disallowedContent: list(str(form, "disallowedContent")),
          allowFanPages: str(form, "allowFanPages") === "on",
          notes: str(form, "notes") || undefined,
        },
        allowedPlatforms: form.getAll("allowedPlatforms").map(String) as ("INSTAGRAM" | "YOUTUBE")[],
        ratePer1kViewsPaise: money(form, "rate", true)!,
        budgetPaise: money(form, "budget", true)!,
        platformFeeBps: defaults.platformFeeBps,
        gstOnFeeBps: defaults.gstOnFeeBps,
        maxPayoutPerSubmissionPaise: money(form, "maxPerSubmission", false),
        maxPayoutPerClipperPaise: money(form, "maxPerClipper", false),
        minViewsToQualify: Number(str(form, "minViews") || 0),
        trackingWindowDays: Number(str(form, "trackingWindowDays") || defaults.trackingWindowDays),
        holdPeriodDays: defaults.holdPeriodDays,
        startsAt: date("startsAt"),
        endsAt: date("endsAt"),
        isManaged: managed,
      },
      user.id,
      await actorFor(user),
    );
    id = campaign.id;
  });
  if (result.error) return result;
  redirect(`/funder/campaigns/${id}?created=1`);
}

async function assertCampaignAccess(campaignId: string) {
  const user = await requireUser();
  const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await requireOrgMember(user.id, c.organizationId, user.roles.includes("ADMIN"));
  if (!user.roles.includes("FUNDER") && !user.roles.includes("ADMIN")) throw new Error("forbidden");
  return { user, campaign: c };
}

export async function fundAction(_: ActionState, form: FormData): Promise<ActionState> {
  let url = "";
  const result = await runAction(async () => {
    const { user, campaign } = await assertCampaignAccess(str(form, "campaignId"));
    const order = await startFunding(campaign.id, await actorFor(user));
    if (order.checkout.kind !== "redirect")
      return { error: "Razorpay Checkout needs the client-side widget (not wired in v0.1)." };
    url = order.checkout.url;
  });
  if (result.error) return result;
  redirect(url);
}

export async function campaignControlAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { user, campaign } = await assertCampaignAccess(str(form, "campaignId"));
    const actor = await actorFor(user);
    const op = str(form, "op");
    if (op === "pause") await pauseCampaign(campaign.id, actor);
    else if (op === "resume") await resumeCampaign(campaign.id, actor);
    else if (op === "end") await endCampaign(campaign.id, actor);
    else return { error: "Unknown action" };
    revalidatePath(`/funder/campaigns/${campaign.id}`);
    return {
      ok: true,
      message: `Campaign ${op === "end" ? "ended" : op === "pause" ? "paused" : "resumed"}.`,
    };
  });
}
