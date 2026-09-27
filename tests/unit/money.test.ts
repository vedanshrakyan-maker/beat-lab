import { describe, expect, it } from "vitest";
import {
  bpsOf,
  earningsForViews,
  formatINR,
  formatINRCompact,
  formatViewsIndian,
  fundingBreakdown,
  jsonSafe,
  parseRupeesToPaise,
  rupees,
  toPaise,
  viewsForAmount,
} from "@/lib/money";

describe("money", () => {
  it("formats with Indian digit grouping", () => {
    expect(formatINR(0n)).toBe("₹0");
    expect(formatINR(50000n)).toBe("₹500");
    expect(formatINR(1_00_000_00n)).toBe("₹1,00,000");
    expect(formatINR(12_34_56_789_00n)).toBe("₹12,34,56,789");
    expect(formatINR(3050n)).toBe("₹30.50");
    expect(formatINR(3000n, { alwaysShowPaise: true })).toBe("₹30.00");
    expect(formatINR(-12345n)).toBe("-₹123.45");
    expect(formatINR(99n)).toBe("₹0.99");
  });

  it("formats compact lakh/crore amounts", () => {
    expect(formatINRCompact(rupees(3_40_000))).toBe("₹3.4L");
    expect(formatINRCompact(rupees(1_25_00_000))).toBe("₹1.25Cr");
    expect(formatINRCompact(rupees(45_000))).toBe("₹45,000");
  });

  it("parses rupee input without floats", () => {
    expect(parseRupeesToPaise("1,00,000")).toBe(1_00_000_00n);
    expect(parseRupeesToPaise("₹ 2500.5")).toBe(2_500_50n);
    expect(parseRupeesToPaise("30.75")).toBe(3075n);
    expect(parseRupeesToPaise("0.1")).toBe(10n);
    expect(parseRupeesToPaise("12.345")).toBeNull();
    expect(parseRupeesToPaise("-5")).toBeNull();
    expect(parseRupeesToPaise("abc")).toBeNull();
    // 0.1 + 0.2 style float errors can't happen: this is exact.
    expect(parseRupeesToPaise("0.10")! + parseRupeesToPaise("0.20")!).toBe(30n);
  });

  it("rejects fractional paise", () => {
    expect(() => toPaise(1.5)).toThrow();
    expect(() => toPaise("1.5")).toThrow();
    expect(toPaise("42")).toBe(42n);
  });

  it("computes basis points rounding down", () => {
    expect(bpsOf(10_000n, 1000)).toBe(1000n);
    expect(bpsOf(999n, 1000)).toBe(99n);
    expect(() => bpsOf(1n, 1.5)).toThrow();
  });

  it("computes earnings per 1K views, rounding down to the paisa", () => {
    expect(earningsForViews(1000, 3000n)).toBe(3000n); // ₹30 per 1K
    expect(earningsForViews(1, 3000n)).toBe(3n);
    expect(earningsForViews(333, 3000n)).toBe(999n);
    expect(earningsForViews(0, 3000n)).toBe(0n);
    expect(viewsForAmount(5_00_000n, 3000n)).toBe(166_667n);
    expect(earningsForViews(166_667, 3000n)).toBeGreaterThanOrEqual(5_00_000n);
    expect(earningsForViews(166_666, 3000n)).toBeLessThan(5_00_000n);
  });

  it("charges the fee on top of the budget, GST on the fee only", () => {
    const b = fundingBreakdown(1_00_000_00n, 1000, 1800);
    expect(b.budgetPaise).toBe(1_00_000_00n);
    expect(b.feePaise).toBe(10_000_00n);
    expect(b.gstPaise).toBe(1_800_00n);
    expect(b.totalPaise).toBe(1_11_800_00n);
  });

  it("formats views in lakh and crore", () => {
    expect(formatViewsIndian(3_333_333)).toBe("33.3 lakh");
    expect(formatViewsIndian(12_000_000)).toBe("1.2 crore");
    expect(formatViewsIndian(45_000)).toBe("45,000");
  });

  it("serializes bigint safely", () => {
    expect(jsonSafe({ a: 1n, b: [2n] })).toEqual({ a: "1", b: ["2"] });
  });
});
