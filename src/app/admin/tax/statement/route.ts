import { NextResponse } from "next/server";
import { annualTdsStatementCsv } from "@/domain/tax";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { actorFor, requireUser } from "@/lib/session";

/** Per-clipper annual earnings & TDS statement for a financial year (?fy=2026 → FY 2026-27). */
export async function GET(req: Request) {
  try {
    const user = await requireUser("ADMIN");
    const fy = Number(new URL(req.url).searchParams.get("fy"));
    if (!Number.isInteger(fy) || fy < 2020 || fy > 2100)
      return NextResponse.json({ error: "fy must be a year" }, { status: 400 });
    const csv = await annualTdsStatementCsv(fy);
    await audit(db, await actorFor(user), "tax.statement_export", "TaxStatement", String(fy));
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tds-statement-FY${fy}-${(fy + 1) % 100}.csv"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
