import type { PollingSettings } from "@/lib/settings";

/**
 * Metrics polling schedule (Section 6.5): snapshots at T+0, T+1h, T+6h, T+24h, then every
 * 24h until the tracking window ends. Offsets are configurable via the `polling` setting.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Special snapshot slots (regular polling slots are 0..n). */
export const SLOT_LOCK = 1000;
export const SLOT_HOLD_END = 2000;

export function trackingOffsetsHours(
  trackingWindowDays: number,
  polling: Pick<PollingSettings, "initialOffsetsHours" | "dailyEveryHours">,
): number[] {
  const end = trackingWindowDays * 24;
  const offsets = [...new Set(polling.initialOffsetsHours)].sort((a, b) => a - b).filter((h) => h < end);
  let next = (offsets[offsets.length - 1] ?? 0) + polling.dailyEveryHours;
  while (next < end) {
    offsets.push(next);
    next += polling.dailyEveryHours;
  }
  return offsets;
}

/** When slot `slot` is due, or null once the schedule is exhausted (the lock takes over). */
export function snapshotDueAt(
  trackingStartedAt: Date,
  slot: number,
  trackingWindowDays: number,
  polling: Pick<PollingSettings, "initialOffsetsHours" | "dailyEveryHours">,
): Date | null {
  const offsets = trackingOffsetsHours(trackingWindowDays, polling);
  const h = offsets[slot];
  return h === undefined ? null : new Date(trackingStartedAt.getTime() + h * HOUR_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
