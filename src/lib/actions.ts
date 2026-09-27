import { ZodError } from "zod";
import { AuthError } from "@/lib/session";

/** Result shape every server action returns to <ActionForm>. */
export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Arbitrary extra data (e.g. rule checks after submitting a post). */
  data?: unknown;
}

const USER_FACING = [
  "SubmissionError",
  "PayoutError",
  "ReviewError",
  "CampaignError",
  "SocialAccountError",
  "AuthError",
  "PlatformNotSupportedError",
];

/** Run an action body, mapping expected errors to a friendly message (never leaking internals). */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (e) {
    if (e instanceof ZodError) {
      const first = e.issues[0];
      return { error: first ? `${first.path.join(".") || "Input"}: ${first.message}` : "Invalid input" };
    }
    if (e instanceof AuthError || (e instanceof Error && USER_FACING.includes(e.constructor.name))) {
      return { error: e.message };
    }
    // Next.js redirect()/notFound() must propagate.
    if (e && typeof e === "object" && "digest" in e) throw e;
    console.error("[action] unexpected error", e);
    return { error: "Something went wrong. Please try again." };
  }
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}
