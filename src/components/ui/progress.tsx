import { cn } from "@/lib/utils";

/** `value` and `max` are bigint paise or numbers; rendered as a thin bar. */
export function Progress({
  value,
  max,
  className,
}: {
  value: bigint | number;
  max: bigint | number;
  className?: string;
}) {
  const v = Number(value);
  const m = Number(max);
  const pct = m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0;
  return (
    <div className={cn("bg-surface-2 h-1.5 w-full overflow-hidden rounded-full", className)}>
      <div className="bg-accent h-full rounded-full" style={{ width: `${pct}%` }} />
    </div>
  );
}
