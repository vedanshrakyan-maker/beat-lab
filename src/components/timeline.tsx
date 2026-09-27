import type { Submission } from "@prisma/client";
import { cn, formatDate } from "@/lib/utils";

const ORDER = ["SUBMITTED", "TRACKING", "LOCKED", "HELD", "PAYABLE", "PAID"] as const;

/** Submitted → tracking → locked → held → payable → paid. */
export function SubmissionTimeline({ s }: { s: Submission }) {
  const at: Record<(typeof ORDER)[number], Date | null> = {
    SUBMITTED: s.submittedAt,
    TRACKING: s.approvedAt,
    LOCKED: s.lockedAt,
    HELD: s.lockedAt,
    PAYABLE: s.payableAt,
    PAID: s.paidAt,
  };
  const labels = {
    SUBMITTED: "Submitted",
    TRACKING: "Tracking",
    LOCKED: "Locked",
    HELD: "On hold",
    PAYABLE: "Payable",
    PAID: "Paid",
  };
  const hints: Partial<Record<(typeof ORDER)[number], string>> = {
    TRACKING: s.trackingEndsAt ? `until ${formatDate(s.trackingEndsAt)}` : undefined,
    HELD: s.holdEndsAt ? `until ${formatDate(s.holdEndsAt)}` : undefined,
  };
  const stopped = ["REJECTED", "VOIDED", "CLAWED_BACK"].includes(s.status);
  return (
    <ol className="grid grid-cols-3 gap-y-4 sm:grid-cols-6">
      {ORDER.map((step) => {
        const done = !!at[step];
        return (
          <li key={step} className="relative pr-2">
            <div
              className={cn(
                "mb-2 h-1 rounded-full",
                done ? (stopped ? "bg-bad/60" : "bg-accent") : "bg-surface-2",
              )}
            />
            <div className={cn("text-sm", done ? "text-fg" : "text-muted")}>{labels[step]}</div>
            <div className="text-muted text-xs">{done ? formatDate(at[step]) : (hints[step] ?? "")}</div>
          </li>
        );
      })}
    </ol>
  );
}
