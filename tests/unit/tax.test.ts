import { describe, expect, it } from "vitest";
import { computeTds, financialYearOf, toCsv } from "@/domain/tax";

const rule = {
  id: "r1",
  name: "Placeholder",
  sectionLabel: "Professional/contract fees — CONFIRM WITH CA",
  ratePctBps: 1000,
  rateWithoutPanBps: 2000,
  annualThresholdPaise: 30_000_00n,
  perTransactionThresholdPaise: null as bigint | null,
};

describe("TDS", () => {
  it("withholds nothing below the annual threshold", () => {
    const r = computeTds(rule, 10_000_00n, 5_000_00n, true);
    expect(r.tdsPaise).toBe(0n);
    expect(r.explanation).toMatch(/below threshold/);
  });

  it("applies the rate once FY cumulative crosses the threshold", () => {
    const r = computeTds(rule, 10_000_00n, 25_000_00n, true);
    expect(r.thresholdCrossed).toBe(true);
    expect(r.tdsPaise).toBe(1_000_00n);
    expect(r.explanation).toContain("CONFIRM WITH CA");
  });

  it("applies the higher rate without a verified PAN", () => {
    expect(computeTds(rule, 10_000_00n, 25_000_00n, false).tdsPaise).toBe(2_000_00n);
  });

  it("honours a per-transaction threshold", () => {
    const r = computeTds({ ...rule, perTransactionThresholdPaise: 5_000_00n }, 6_000_00n, 0n, true);
    expect(r.tdsPaise).toBe(60_000n);
    expect(r.explanation).toMatch(/per-payment threshold/);
  });

  it("returns zero with no active rule", () => {
    expect(computeTds(null, 10_000_00n, 0n, true).tdsPaise).toBe(0n);
  });

  it("uses the Indian financial year in IST", () => {
    expect(financialYearOf(new Date("2026-04-01T00:00:00+05:30")).label).toBe("2026-27");
    expect(financialYearOf(new Date("2026-03-31T23:59:00+05:30")).label).toBe("2025-26");
    // 31 Mar 19:00 UTC is already 1 Apr in IST
    expect(financialYearOf(new Date("2026-03-31T19:00:00Z")).label).toBe("2026-27");
  });

  it("escapes CSV cells", () => {
    expect(toCsv([["a,b", 'say "hi"', 1n]])).toBe('"a,b","say ""hi""",1\n');
  });
});
