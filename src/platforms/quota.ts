import { db } from "@/lib/db";

/**
 * Daily API quota bookkeeping (YouTube Data API: 10,000 units/day by default, resets at
 * midnight Pacific Time). Adapters check `canSpend` before calling and `record` after.
 */
export interface QuotaTracker {
  canSpend(units: number): Promise<boolean>;
  record(units: number): Promise<void>;
  usedToday(): Promise<number>;
}

export function pacificDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export class DbQuotaTracker implements QuotaTracker {
  constructor(
    private readonly provider: string,
    private readonly dailyLimit: number,
    /** Stop at this fraction (bps) of the daily limit, leaving headroom for admin actions. */
    private readonly stopAtBps: number,
  ) {}

  async usedToday(): Promise<number> {
    const row = await db.apiQuotaUsage.findUnique({
      where: { provider_day: { provider: this.provider, day: pacificDay() } },
    });
    return row?.units ?? 0;
  }

  async canSpend(units: number): Promise<boolean> {
    const used = await this.usedToday();
    return used + units <= Math.floor((this.dailyLimit * this.stopAtBps) / 10_000);
  }

  async record(units: number): Promise<void> {
    const day = pacificDay();
    await db.apiQuotaUsage.upsert({
      where: { provider_day: { provider: this.provider, day } },
      create: { provider: this.provider, day, units },
      update: { units: { increment: units } },
    });
  }
}

/** In-memory tracker for tests. */
export class MemoryQuotaTracker implements QuotaTracker {
  used = 0;
  constructor(private readonly limit = 10_000) {}
  async canSpend(units: number) {
    return this.used + units <= this.limit;
  }
  async record(units: number) {
    this.used += units;
  }
  async usedToday() {
    return this.used;
  }
}
