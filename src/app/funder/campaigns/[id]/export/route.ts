import { NextResponse } from "next/server";
import { campaignResultsCsv } from "@/domain/analytics";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { actorFor, AuthError, requireOrgMember, requireUser } from "@/lib/session";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser();
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id } });
    await requireOrgMember(user.id, campaign.organizationId, user.roles.includes("ADMIN"));
    const csv = await campaignResultsCsv(campaign);
    await audit(db, await actorFor(user), "campaign.export_csv", "Campaign", id);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="campaign-${id}.csv"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof AuthError ? e.message : "Not found" },
      { status: e instanceof AuthError ? 403 : 404 },
    );
  }
}
