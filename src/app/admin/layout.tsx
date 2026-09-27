import Link from "next/link";
import { requirePageUser } from "@/lib/session";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/review", label: "Review queue" },
  { href: "/admin/payouts", label: "Payouts" },
  { href: "/admin/campaigns", label: "Campaigns" },
  { href: "/admin/settings", label: "Settings & tax" },
  { href: "/admin/audit", label: "Audit log" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser("ADMIN");
  return (
    <div>
      <nav className="border-border mb-8 flex gap-1 overflow-x-auto border-b pb-3 text-sm">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-muted hover:bg-surface-2 hover:text-fg rounded-full px-3 py-1.5 whitespace-nowrap"
          >
            {l.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
