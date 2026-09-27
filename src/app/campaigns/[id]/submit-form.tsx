"use client";

import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input, Select } from "@/components/ui/form";
import type { RuleCheck } from "@/domain/submissions";
import { submitAction } from "./actions";

export function SubmitForm({
  campaignId,
  accounts,
  scenarios,
}: {
  campaignId: string;
  accounts: { id: string; label: string }[];
  scenarios: string[] | null;
}) {
  return (
    <ActionForm
      action={submitAction}
      render={(state) => {
        const data = state.data as { checks?: RuleCheck[]; submissionId?: string } | undefined;
        if (!data?.checks?.length) return null;
        return (
          <div className="space-y-2">
            <ul className="space-y-1.5 text-sm">
              {data.checks.map((c) => (
                <li key={c.label} className="flex items-center gap-2">
                  <span className={c.ok ? "text-good" : "text-bad"}>{c.ok ? "✓" : "✗"}</span>
                  <span>{c.label}</span>
                  {c.detail ? <span className="text-muted">— {c.detail}</span> : null}
                </li>
              ))}
            </ul>
            {data.submissionId ? (
              <Link
                className="text-accent text-sm underline"
                href={`/clipper/submissions/${data.submissionId}`}
              >
                View submission →
              </Link>
            ) : null}
          </div>
        );
      }}
    >
      <input type="hidden" name="campaignId" value={campaignId} />
      <Field label="Posted from">
        <Select name="socialAccountId" required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Post link" hint="The public link to your Reel or Short.">
        <Input
          name="postUrl"
          type="url"
          required
          placeholder="https://www.instagram.com/reel/…"
          data-testid="post-url"
        />
      </Field>
      {scenarios ? (
        <Field
          label="Mock scenario (dev only)"
          hint="Drives the MockAdapter's simulated views for this post."
        >
          <Select name="mockScenario" defaultValue="">
            <option value="">Random clean traffic</option>
            {scenarios.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <SubmitButton pendingText="Checking your post…" className="w-full">
        Submit post
      </SubmitButton>
    </ActionForm>
  );
}
