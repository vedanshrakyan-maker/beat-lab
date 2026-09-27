import { formatCount } from "@/lib/money";

/**
 * Minimal inline-SVG line chart (no chart library). Points are (time, views).
 * Server-rendered; works on mobile.
 */
export function ViewsChart({
  points,
  height = 180,
  lockedAt,
  capViews,
}: {
  points: { t: Date; v: number }[];
  height?: number;
  lockedAt?: Date | null;
  capViews?: number | null;
}) {
  if (points.length === 0)
    return <div className="text-muted flex h-40 items-center justify-center text-sm">No snapshots yet</div>;
  const width = 640;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const t0 = points[0]!.t.getTime();
  const t1 = Math.max(points[points.length - 1]!.t.getTime(), t0 + 3_600_000);
  const vMax = Math.max(1, ...points.map((p) => p.v), capViews ?? 0) * 1.08;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / vMax) * (height - pad.t - pad.b);
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.t.getTime()).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const area = `${d} L${x(points[points.length - 1]!.t.getTime()).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, 0.5, 1].map((f) => Math.round(vMax * f));
  const days = (t1 - t0) / 86_400_000;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Views over time">
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={pad.l}
            x2={width - pad.r}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--color-border)"
            strokeDasharray="2 4"
          />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--color-muted)">
            {formatCount(v)}
          </text>
        </g>
      ))}
      {capViews ? (
        <g>
          <line
            x1={pad.l}
            x2={width - pad.r}
            y1={y(capViews)}
            y2={y(capViews)}
            stroke="var(--color-warn)"
            strokeOpacity="0.5"
            strokeDasharray="6 4"
          />
          <text x={width - pad.r} y={y(capViews) - 4} textAnchor="end" fontSize="10" fill="var(--color-warn)">
            payout cap
          </text>
        </g>
      ) : null}
      {lockedAt && lockedAt.getTime() >= t0 && lockedAt.getTime() <= t1 ? (
        <line
          x1={x(lockedAt.getTime())}
          x2={x(lockedAt.getTime())}
          y1={pad.t}
          y2={y(0)}
          stroke="var(--color-muted)"
          strokeDasharray="3 3"
        />
      ) : null}
      <path d={area} fill="var(--color-accent)" fillOpacity="0.08" />
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(p.t.getTime())} cy={y(p.v)} r="2.5" fill="var(--color-accent)" />
      ))}
      <text x={pad.l} y={height - 6} fontSize="10" fill="var(--color-muted)">
        T+0
      </text>
      <text x={width - pad.r} y={height - 6} textAnchor="end" fontSize="10" fill="var(--color-muted)">
        +{days < 2 ? `${Math.round(days * 24)}h` : `${Math.round(days)}d`}
      </text>
    </svg>
  );
}
