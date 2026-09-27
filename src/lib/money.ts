/**
 * Money helpers. ALL money in ReelPay is an integer number of paise held in a `bigint`.
 * Floats never touch money: parsing, arithmetic and formatting here are all integer-based.
 * Format to rupees only at the UI edge (formatINR).
 */

export type Paise = bigint;

export const PAISE_PER_RUPEE = 100n;
const BPS_DENOMINATOR = 10_000n;

/** Coerce a safe integer / bigint / integer string to paise. Throws on fractional input. */
export function toPaise(value: number | bigint | string): Paise {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Paise must be a safe integer, got ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`Paise must be an integer string, got "${value}"`);
  return BigInt(value.trim());
}

/** Whole rupees (integer) to paise. */
export function rupees(amount: number | bigint): Paise {
  return toPaise(amount) * PAISE_PER_RUPEE;
}

/**
 * Parse user-entered rupees ("1,00,000", "₹ 2500.5", "30.75") into paise without floats.
 * Returns null for anything that isn't a non-negative amount with at most 2 decimals.
 */
export function parseRupeesToPaise(input: string): Paise | null {
  const cleaned = input.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return whole * PAISE_PER_RUPEE + fraction;
}

/** Indian digit grouping: 1234567 -> "12,34,567". */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

export interface FormatOptions {
  /** Always show paise ("₹30.00"). Default: show paise only when non-zero. */
  alwaysShowPaise?: boolean;
  /** Omit the ₹ symbol. */
  noSymbol?: boolean;
}

/** Format paise as Indian rupees: 10000000n -> "₹1,00,000". */
export function formatINR(amount: Paise, options: FormatOptions = {}): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = abs % PAISE_PER_RUPEE;
  let out = groupIndian(whole.toString());
  if (fraction !== 0n || options.alwaysShowPaise) out += `.${fraction.toString().padStart(2, "0")}`;
  const symbol = options.noSymbol ? "" : "₹";
  return `${negative ? "-" : ""}${symbol}${out}`;
}

/** Compact Indian format for dashboards: "₹3.4L", "₹1.25Cr". Integer arithmetic only. */
export function formatINRCompact(amount: Paise): string {
  const negative = amount < 0n;
  const rupeesWhole = (negative ? -amount : amount) / PAISE_PER_RUPEE;
  const sign = negative ? "-" : "";
  const withUnit = (value: bigint, unit: bigint, suffix: string) => {
    const hundredths = (value * 100n) / unit; // two decimals, truncated
    const int = hundredths / 100n;
    const dec = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
    return `${sign}₹${int}${dec ? `.${dec}` : ""}${suffix}`;
  };
  if (rupeesWhole >= 1_00_00_000n) return withUnit(rupeesWhole, 1_00_00_000n, "Cr");
  if (rupeesWhole >= 1_00_000n) return withUnit(rupeesWhole, 1_00_000n, "L");
  return formatINR(negative ? -rupeesWhole * 100n : rupeesWhole * 100n);
}

/** Basis-point share of an amount, rounded down: bpsOf(10000n, 1000) = 1000n (10%). */
export function bpsOf(amount: Paise, bps: number): Paise {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bps must be a non-negative integer, got ${bps}`);
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Earnings for a view count at a rate per 1,000 views, rounded down to the paisa. */
export function earningsForViews(views: number | bigint, ratePer1kViewsPaise: Paise): Paise {
  const v = typeof views === "bigint" ? views : toPaise(Math.max(0, Math.trunc(views)));
  return (v * ratePer1kViewsPaise) / 1000n;
}

/** Smallest view count whose earnings reach `amount` (ceil). Used for caps and estimates. */
export function viewsForAmount(amount: Paise, ratePer1kViewsPaise: Paise): bigint {
  if (ratePer1kViewsPaise <= 0n) throw new Error("rate must be positive");
  return (amount * 1000n + ratePer1kViewsPaise - 1n) / ratePer1kViewsPaise;
}

export function minPaise(...values: Paise[]): Paise {
  return values.reduce((a, b) => (b < a ? b : a));
}

export function maxPaise(...values: Paise[]): Paise {
  return values.reduce((a, b) => (b > a ? b : a));
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export interface FundingBreakdown {
  budgetPaise: Paise;
  feePaise: Paise;
  gstPaise: Paise;
  totalPaise: Paise;
}

/**
 * What a funder pays. The platform fee is charged ON TOP of the budget, so the
 * clipper-facing pool is the full budget. GST applies to the fee only.
 */
export function fundingBreakdown(
  budgetPaise: Paise,
  platformFeeBps: number,
  gstOnFeeBps: number,
): FundingBreakdown {
  const feePaise = bpsOf(budgetPaise, platformFeeBps);
  const gstPaise = bpsOf(feePaise, gstOnFeeBps);
  return { budgetPaise, feePaise, gstPaise, totalPaise: budgetPaise + feePaise + gstPaise };
}

/** "33 lakh", "1.2 crore", "45,000" — Indian units for view counts (display only, not money). */
export function formatViewsIndian(views: number | bigint): string {
  const n = typeof views === "bigint" ? views : BigInt(Math.max(0, Math.trunc(views)));
  const oneDecimal = (value: bigint, unit: bigint, word: string) => {
    const tenths = (value * 10n) / unit;
    const int = tenths / 10n;
    const dec = tenths % 10n;
    return `${int}${dec === 0n ? "" : `.${dec}`} ${word}`;
  };
  if (n >= 1_00_00_000n) return oneDecimal(n, 1_00_00_000n, "crore");
  if (n >= 1_00_000n) return oneDecimal(n, 1_00_000n, "lakh");
  return groupIndian(n.toString());
}

/** Short numeric view formatting for charts: 1234 -> "1.2K", 3400000 -> "3.4M". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

/** BigInt-safe JSON for audit logs and API responses. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
