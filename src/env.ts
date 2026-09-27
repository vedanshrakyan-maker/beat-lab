import { z } from "zod";

/**
 * Validated environment. Parsed lazily (on first access) so that tooling such as
 * `next build` and unit tests that never touch a given variable don't need it set.
 */
const DEV_ENCRYPTION_KEY = "ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE=";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Deployment environment. Production guards key off this (NOT NODE_ENV, which `next build` forces). */
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    APP_URL: z.string().url().default("http://localhost:3000"),
    AUTH_SECRET: z.string().min(16).optional(),
    ALLOW_DEV_LOGIN: bool,
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64"),

    YOUTUBE_ADAPTER: z.enum(["mock", "live"]).default("mock"),
    YOUTUBE_API_KEY: z.string().optional(),
    YOUTUBE_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

    INSTAGRAM_ADAPTER: z.enum(["mock", "live"]).default("mock"),
    IG_APP_ID: z.string().optional(),
    IG_APP_SECRET: z.string().optional(),
    IG_GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default("v23.0"),

    PAYMENTS_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),
    MOCK_WEBHOOK_SECRET: z.string().default("dev-only-mock-webhook-secret"),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),

    EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
    EMAIL_FROM: z.string().default("ReelPay <no-reply@reelpay.local>"),
    SMTP_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "production") return;
    if (env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
      ctx.addIssue({ code: "custom", path: ["ENCRYPTION_KEY"], message: "Dev-only key used in production" });
    }
    if (env.ALLOW_DEV_LOGIN) {
      ctx.addIssue({
        code: "custom",
        path: ["ALLOW_DEV_LOGIN"],
        message: "Dev login must be off in production",
      });
    }
    if (!env.AUTH_SECRET || env.AUTH_SECRET.startsWith("dev-only")) {
      ctx.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "Set a real AUTH_SECRET" });
    }
    if (env.YOUTUBE_ADAPTER === "live" && !env.YOUTUBE_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["YOUTUBE_API_KEY"],
        message: "Required when YOUTUBE_ADAPTER=live",
      });
    }
    if (env.PAYMENTS_PROVIDER === "razorpay" && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
      ctx.addIssue({ code: "custom", path: ["RAZORPAY_KEY_ID"], message: "Razorpay keys required" });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      // Print variable names only: never echo values (they may be secrets).
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test helper: forget the cached env after mutating process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export function devLoginEnabled(): boolean {
  const e = env();
  return e.APP_ENV !== "production" && e.ALLOW_DEV_LOGIN;
}
