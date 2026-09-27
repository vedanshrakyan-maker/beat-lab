import type { SnapshotPoint } from "@/fraud/types";

export const HOUR_MS = 3_600_000;

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR_MS;
}

export interface Interval {
  from: SnapshotPoint;
  to: SnapshotPoint;
  hours: number;
  gain: number;
  hourlyGain: number;
}

export function intervals(snapshots: SnapshotPoint[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const from = snapshots[i - 1]!;
    const to = snapshots[i]!;
    const hours = hoursBetween(from.capturedAt, to.capturedAt);
    if (hours <= 0) continue;
    const gain = to.views - from.views;
    out.push({ from, to, hours, gain, hourlyGain: gain / hours });
  }
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function latest(snapshots: SnapshotPoint[]): SnapshotPoint | undefined {
  return snapshots[snapshots.length - 1];
}
