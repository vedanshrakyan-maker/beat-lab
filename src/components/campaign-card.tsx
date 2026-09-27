import Link from "next/link";
import type { CampaignCard as Card } from "@/domain/queries";
import { formatINR, formatINRCompact } from "@/lib/money";
import { Progress } from "@/components/ui/progress";
import { CampaignStatusBadge, PlatformBadge } from "@/components/status";
import { t } from "@/i18n";

export function CampaignCard({ c, href }: { c: Card; href?: string }) {
  return (
    <Link
      href={href ?? `/campaigns/${c.id}`}
      className="group border-border bg-surface hover:border-fg/30 flex flex-col rounded-2xl border p-5 transition-colors"
    >
      <div className="text-muted mb-3 flex items-center justify-between gap-2 text-xs">
        <span className="tracking-wide uppercase">
          {c.category} · {c.type === "CLIPPING" ? "Clipping" : "UGC"}
        </span>
        <CampaignStatusBadge status={c.status} />
      </div>
      <h3 className="group-hover:text-accent font-serif text-xl leading-snug">{c.title}</h3>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="tabular text-accent font-serif text-3xl">{formatINR(c.ratePer1kViewsPaise)}</span>
        <span className="text-muted text-sm">{t("campaign.ratePer1k")}</span>
      </div>
      <div className="mt-5">
        <Progress value={c.remainingPaise} max={c.budgetPaise} />
        <div className="text-muted mt-2 text-xs">
          {t("campaign.budgetRemaining", {
            remaining: formatINRCompact(c.remainingPaise),
            budget: formatINRCompact(c.budgetPaise),
          })}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {c.allowedPlatforms.map((p) => (
          <PlatformBadge key={p} platform={p} />
        ))}
      </div>
    </Link>
  );
}
