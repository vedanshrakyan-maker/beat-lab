import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("border-border bg-surface rounded-2xl border p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3 className={cn("text-muted text-sm font-medium tracking-wide uppercase", className)} {...props} />
  );
}

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="border-border bg-surface rounded-2xl border p-5">
      <div className="text-muted text-xs tracking-wide uppercase">{label}</div>
      <div className={cn("tabular mt-2 font-serif text-3xl", accent && "text-accent")}>{value}</div>
      {hint ? <div className="text-muted mt-1 text-xs">{hint}</div> : null}
    </div>
  );
}
