import { z } from "zod";
import { db, type DbOrTx } from "@/lib/db";

/**
 * Every tunable threshold lives in the `Setting` table (editable in the admin panel,
 * audit-logged). Defaults below are written by the seed and used as fallbacks.
 */

export const fraudRuleKeys = [
  "VELOCITY_SPIKE",
  "LOW_ENGAGEMENT_RATIO",
  "VIEWS_TO_REACH_RATIO",
  "SMALL_ACCOUNT_OUTLIER",
  "PLATEAU_AT_CAP",
  "DELETED_OR_PRIVATE_AFTER_LOCK",
  "VIEW_DROP_AFTER_LOCK",
  "DUPLICATE_SUBMISSION",
  "MULTI_ACCOUNT_LINK",
  "RULE_VIOLATION_HINTS",
] as const;
export type FraudRuleKey = (typeof fraudRuleKeys)[number];

const ruleToggle = z.object({ enabled: z.boolean(), weight: z.number().min(0).max(5) });

export const fraudSettingsSchema = z.object({
  rules: z.record(z.enum(fraudRuleKeys), ruleToggle),
  bands: z.object({
    /** score < reviewAt -> AUTO_APPROVE */
    reviewAt: z.number().int().min(1).max(100),
    /** score >= flagAt -> AUTO_FLAG (earnings frozen) */
    flagAt: z.number().int().min(1).max(100),
    /** Manual (screen-recording) metrics use stricter bands: thresholds are reduced by this much. */
    manualStrictnessOffset: z.number().int().min(0).max(50),
  }),
  thresholds: z.object({
    velocitySpikeMultiplier: z.number().positive(),
    velocityMinAbsoluteHourlyGain: z.number().int().nonnegative(),
    velocityBaselineHourlyGain: z.number().int().positive(),
    jumpShareOfTotal: z.number().min(0).max(1),
    jumpMaxIntervalHours: z.number().positive(),
    flatAfterJumpMaxGrowth: z.number().min(0).max(1),
    flatAfterJumpMinHours: z.number().positive(),
    engagementFloorBps: z.object({
      INSTAGRAM: z.number().int(),
      YOUTUBE: z.number().int(),
      X: z.number().int(),
    }),
    engagementMinViews: z.number().int().nonnegative(),
    viewsToReachMax: z.number().positive(),
    reachMinViews: z.number().int().nonnegative(),
    smallAccountFollowers: z.number().int().nonnegative(),
    smallAccountAgeDays: z.number().int().nonnegative(),
    smallAccountViewsPerFollower: z.number().positive(),
    smallAccountMinViews: z.number().int().nonnegative(),
    plateauBandPct: z.number().min(0).max(0.5),
    plateauMinSnapshots: z.number().int().min(2),
    viewDropFlagPct: z.number().min(0).max(1),
    viewDropNoticePct: z.number().min(0).max(1),
  }),
});
export type FraudSettings = z.infer<typeof fraudSettingsSchema>;

export const defaultFraudSettings: FraudSettings = {
  rules: {
    VELOCITY_SPIKE: { enabled: true, weight: 1 },
    LOW_ENGAGEMENT_RATIO: { enabled: true, weight: 0.8 },
    VIEWS_TO_REACH_RATIO: { enabled: true, weight: 1 },
    SMALL_ACCOUNT_OUTLIER: { enabled: true, weight: 0.4 },
    PLATEAU_AT_CAP: { enabled: true, weight: 1 },
    DELETED_OR_PRIVATE_AFTER_LOCK: { enabled: true, weight: 1 },
    VIEW_DROP_AFTER_LOCK: { enabled: true, weight: 1 },
    DUPLICATE_SUBMISSION: { enabled: true, weight: 0.5 },
    MULTI_ACCOUNT_LINK: { enabled: true, weight: 1 },
    RULE_VIOLATION_HINTS: { enabled: true, weight: 1 },
  },
  bands: { reviewAt: 30, flagAt: 70, manualStrictnessOffset: 10 },
  thresholds: {
    velocitySpikeMultiplier: 14,
    velocityMinAbsoluteHourlyGain: 5_000,
    velocityBaselineHourlyGain: 400,
    jumpShareOfTotal: 0.6,
    jumpMaxIntervalHours: 6,
    flatAfterJumpMaxGrowth: 0.05,
    flatAfterJumpMinHours: 12,
    engagementFloorBps: { INSTAGRAM: 30, YOUTUBE: 30, X: 30 }, // 0.3%
    engagementMinViews: 1_000,
    viewsToReachMax: 3,
    reachMinViews: 1_000,
    smallAccountFollowers: 1_000,
    smallAccountAgeDays: 30,
    smallAccountViewsPerFollower: 50,
    smallAccountMinViews: 20_000,
    plateauBandPct: 0.02,
    plateauMinSnapshots: 2,
    viewDropFlagPct: 0.2,
    viewDropNoticePct: 0.05,
  },
};

export const payoutSettingsSchema = z.object({
  /** Minimum withdrawal in paise (default ₹500). Stored as a string because JSON has no bigint. */
  minWithdrawalPaise: z.string().regex(/^\d+$/),
  /** Remaining-budget share (bps) that triggers the "almost exhausted" notification. */
  lowBudgetAlertBps: z.number().int().min(0).max(10_000),
});
export type PayoutSettings = z.infer<typeof payoutSettingsSchema>;
export const defaultPayoutSettings: PayoutSettings = { minWithdrawalPaise: "50000", lowBudgetAlertBps: 1000 };

export const campaignDefaultsSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(5000),
  gstOnFeeBps: z.number().int().min(0).max(5000),
  trackingWindowDays: z.number().int().min(1).max(60),
  holdPeriodDays: z.number().int().min(0).max(60),
});
export type CampaignDefaults = z.infer<typeof campaignDefaultsSchema>;
export const defaultCampaignDefaults: CampaignDefaults = {
  platformFeeBps: 1000,
  gstOnFeeBps: 1800,
  trackingWindowDays: 7,
  holdPeriodDays: 7,
};

export const pollingSettingsSchema = z.object({
  /** Snapshot offsets (hours after tracking starts) before the daily cadence kicks in. */
  initialOffsetsHours: z.array(z.number().nonnegative()),
  dailyEveryHours: z.number().positive(),
  /** Stop polling YouTube once this share of the daily quota is used. */
  youtubeQuotaStopBps: z.number().int().min(0).max(10_000),
});
export type PollingSettings = z.infer<typeof pollingSettingsSchema>;
export const defaultPollingSettings: PollingSettings = {
  initialOffsetsHours: [0, 1, 6, 24],
  dailyEveryHours: 24,
  youtubeQuotaStopBps: 9000,
};

export const settingRegistry = {
  fraud: {
    schema: fraudSettingsSchema,
    defaults: defaultFraudSettings,
    label: "Fraud engine weights & thresholds",
  },
  payouts: { schema: payoutSettingsSchema, defaults: defaultPayoutSettings, label: "Payouts" },
  campaignDefaults: {
    schema: campaignDefaultsSchema,
    defaults: defaultCampaignDefaults,
    label: "Campaign defaults (fees, hold)",
  },
  polling: {
    schema: pollingSettingsSchema,
    defaults: defaultPollingSettings,
    label: "Metrics polling schedule",
  },
} as const;

export type SettingKey = keyof typeof settingRegistry;
type SettingValue<K extends SettingKey> = z.infer<(typeof settingRegistry)[K]["schema"]>;

export async function getSetting<K extends SettingKey>(
  key: K,
  client: DbOrTx = db,
): Promise<SettingValue<K>> {
  const row = await client.setting.findUnique({ where: { key } });
  const entry = settingRegistry[key];
  if (!row) return entry.defaults as SettingValue<K>;
  const parsed = entry.schema.safeParse(row.value);
  // A malformed row should never take the system down: fall back to defaults and let the
  // admin health panel surface it.
  return (parsed.success ? parsed.data : entry.defaults) as SettingValue<K>;
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingRegistry[key].schema.parse(value) as SettingValue<K>;
}
