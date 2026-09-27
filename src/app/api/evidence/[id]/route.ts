import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readUpload } from "@/lib/storage";
import { getCurrentUser } from "@/lib/session";

/** Serve a manual-verification recording to admins (or the clipper who uploaded it). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const ev = await db.manualEvidence.findUnique({ where: { id } });
  if (!user || !ev || (!user.roles.includes("ADMIN") && ev.uploadedById !== user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const bytes = await readUpload(ev.storageKey);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": ev.mimeType,
      "Content-Disposition": `inline; filename="${ev.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
