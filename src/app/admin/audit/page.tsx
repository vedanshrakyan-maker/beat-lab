import Link from "next/link";
import { PageHeader } from "@/components/page";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Table, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log" };

const TYPES = [
  "Submission",
  "Campaign",
  "Payout",
  "PayoutBatch",
  "FundingPayment",
  "Setting",
  "TaxRule",
  "User",
  "SocialAccount",
  "PayoutProfile",
  "Organization",
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; entity?: string; action?: string }>;
}) {
  const sp = await searchParams;
  const logs = await db.auditLog.findMany({
    where: {
      entityType: sp.type || undefined,
      entityId: sp.entity || undefined,
      action: sp.action ? { contains: sp.action } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { email: true } } },
  });
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Audit log"
        subtitle="Append-only: every admin action and every state change on submissions, campaigns and payouts."
      />
      <form className="mb-4 flex flex-wrap gap-2">
        <Select name="type" defaultValue={sp.type ?? ""} className="w-48">
          <option value="">All entities</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Input name="entity" placeholder="Entity id" defaultValue={sp.entity ?? ""} className="w-64" />
        <Input name="action" placeholder="Action contains…" defaultValue={sp.action ?? ""} className="w-48" />
        <Button variant="secondary">Filter</Button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Entity</Th>
            <Th>Change</Th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <Td className="text-muted text-xs whitespace-nowrap">{formatDate(l.createdAt, true)}</Td>
              <Td className="text-xs">{l.actor?.email ?? l.actorLabel}</Td>
              <Td className="font-mono text-xs">{l.action}</Td>
              <Td className="text-xs">
                <Link
                  className="hover:text-accent"
                  href={`/admin/audit?type=${l.entityType}&entity=${l.entityId}`}
                >
                  {l.entityType}
                  <div className="text-muted">{l.entityId}</div>
                </Link>
              </Td>
              <Td className="max-w-md">
                <details className="text-muted text-xs">
                  <summary className="cursor-pointer">before → after</summary>
                  <pre className="bg-bg mt-1 overflow-x-auto rounded p-2">
                    {JSON.stringify({ before: l.before, after: l.after }, null, 2)}
                  </pre>
                </details>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
