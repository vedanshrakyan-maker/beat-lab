"use client";

import { useActionState, useMemo, useState } from "react";
import { FormMessage, SubmitButton } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import type { ActionState } from "@/lib/actions";
import {
  formatINR,
  formatViewsIndian,
  fundingBreakdown,
  parseRupeesToPaise,
  viewsForAmount,
} from "@/lib/money";
import { cn } from "@/lib/utils";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

const STEPS = ["Basics", "Rules", "Budget & payouts", "Review"] as const;

/** Create-campaign wizard with a live estimate. All steps live in one <form>; hidden steps keep their values. */
export function CampaignForm({
  action,
  organizations,
  managed = false,
  feeBps,
  gstBps,
  trackingWindowDays,
  holdPeriodDays,
}: {
  action: Action;
  organizations: { id: string; name: string }[];
  managed?: boolean;
  feeBps: number;
  gstBps: number;
  trackingWindowDays: number;
  holdPeriodDays: number;
}) {
  const [state, formAction] = useActionState(action, {});
  const [step, setStep] = useState(0);
  const [budget, setBudget] = useState("100000");
  const [rate, setRate] = useState("30");
  const [maxPerSub, setMaxPerSub] = useState("5000");
  const [type, setType] = useState("CLIPPING");

  const estimate = useMemo(() => {
    const b = parseRupeesToPaise(budget);
    const r = parseRupeesToPaise(rate);
    const cap = parseRupeesToPaise(maxPerSub);
    if (!b || !r || r === 0n) return null;
    const views = (b * 1000n) / r;
    return {
      views,
      breakdown: fundingBreakdown(b, feeBps, gstBps),
      capViews: cap ? viewsForAmount(cap, r) : null,
      budget: b,
      rate: r,
    };
  }, [budget, rate, maxPerSub, feeBps, gstBps]);

  return (
    <form action={formAction} className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div>
        <ol className="mb-6 flex flex-wrap gap-2">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => setStep(i)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  i === step ? "border-accent text-accent" : "border-border text-muted",
                )}
              >
                {i + 1}. {s}
              </button>
            </li>
          ))}
        </ol>
        {managed ? <input type="hidden" name="managed" value="1" /> : null}

        <Card className={cn("space-y-4", step !== 0 && "hidden")}>
          <Field label={managed ? "Funder organization (managed campaign)" : "Organization"}>
            <Select name="organizationId" required>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              name="title"
              required
              minLength={3}
              maxLength={120}
              placeholder="Clip our podcast: best moments"
            />
          </Field>
          <Field label="Description" hint="What should clippers make? Tone, audience, do's and don'ts.">
            <Textarea name="description" required minLength={10} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <Select name="type" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="CLIPPING">Clipping — cut our long-form content</option>
                <option value="UGC">UGC — original content about us</option>
              </Select>
            </Field>
            <Field label="Category">
              <Input name="category" defaultValue="Podcast" />
            </Field>
          </div>
          <Field
            label="Source content URLs"
            hint={
              type === "CLIPPING"
                ? "Required: one per line — the long-form videos to clip."
                : "Optional: reference material."
            }
          >
            <Textarea name="sourceContentUrls" placeholder="https://www.youtube.com/watch?v=…" />
          </Field>
          <fieldset>
            <legend className="text-muted mb-1.5 text-xs font-medium tracking-wide uppercase">
              Platforms
            </legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="allowedPlatforms" value="INSTAGRAM" defaultChecked /> Instagram
                Reels
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="allowedPlatforms" value="YOUTUBE" defaultChecked /> YouTube
                Shorts
              </label>
            </div>
            <p className="text-muted mt-1 text-xs">TikTok is banned in India; Moj/Josh have no public API.</p>
          </fieldset>
        </Card>

        <Card className={cn("space-y-4", step !== 1 && "hidden")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Required hashtags" hint="Comma separated. Checked automatically.">
              <Input name="requiredHashtags" placeholder="#brandname, #ad" />
            </Field>
            <Field label="Required mentions">
              <Input name="requiredMentions" placeholder="@brandname" />
            </Field>
            <Field label="Min duration (sec)">
              <Input name="minDurationSec" type="number" min={0} max={600} />
            </Field>
            <Field label="Max duration (sec)">
              <Input name="maxDurationSec" type="number" min={1} max={600} defaultValue={90} />
            </Field>
          </div>
          <Field label="Languages">
            <Input name="languages" placeholder="Hindi, English, Tamil" />
          </Field>
          <Field label="Disallowed content" hint="One per line.">
            <Textarea name="disallowedContent" placeholder={"Misleading claims\nCompetitor brands"} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="allowFanPages" defaultChecked /> Allow dedicated fan pages
          </label>
          <Field label="Notes for clippers">
            <Textarea name="notes" />
          </Field>
        </Card>

        <Card className={cn("space-y-4", step !== 2 && "hidden")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Budget (₹)" hint="Clipper-facing pool. The fee is charged on top.">
              <Input
                name="budget"
                inputMode="decimal"
                required
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <Field label="Rate per 1K verified views (₹)">
              <Input
                name="rate"
                inputMode="decimal"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </Field>
            <Field label="Max payout per submission (₹)" hint="Blank = no cap">
              <Input
                name="maxPerSubmission"
                inputMode="decimal"
                value={maxPerSub}
                onChange={(e) => setMaxPerSub(e.target.value)}
              />
            </Field>
            <Field label="Max payout per clipper (₹)" hint="Blank = no cap">
              <Input name="maxPerClipper" inputMode="decimal" />
            </Field>
            <Field label="Minimum views to qualify">
              <Input name="minViews" type="number" min={0} defaultValue={1000} />
            </Field>
            <Field label="Tracking window (days)" hint={`Then a ${holdPeriodDays}-day hold before payout.`}>
              <Input
                name="trackingWindowDays"
                type="number"
                min={1}
                max={30}
                defaultValue={trackingWindowDays}
              />
            </Field>
            <Field label="Starts">
              <Input name="startsAt" type="date" />
            </Field>
            <Field label="Ends">
              <Input name="endsAt" type="date" />
            </Field>
          </div>
        </Card>

        <Card className={cn("space-y-3 text-sm", step !== 3 && "hidden")}>
          <p>
            Your campaign is saved as a <strong>draft</strong>. You fund it on the next screen; it goes live
            once the payment is confirmed.
          </p>
          <p className="text-muted">
            Views are verified by our fraud engine. You only pay for views that pass — blocked views and the
            rupees they would have cost are shown on your dashboard.
          </p>
          <FormMessage state={state} />
          <SubmitButton className="w-full" pendingText="Creating…">
            Create draft campaign
          </SubmitButton>
        </Card>

        <div className="mt-4 flex justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            ← Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" variant="secondary" onClick={() => setStep((s) => s + 1)}>
              Next →
            </Button>
          ) : null}
        </div>
        {step !== 3 ? <FormMessage state={state} /> : null}
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card className="border-accent/30">
          <div className="text-accent text-xs tracking-wide uppercase">Live estimate</div>
          {estimate ? (
            <>
              <p className="mt-3 font-serif text-2xl leading-snug">
                {formatINR(estimate.budget)} at {formatINR(estimate.rate)} per 1K ≈{" "}
                <span className="text-accent">{formatViewsIndian(estimate.views)} views</span>
              </p>
              {estimate.capViews ? (
                <p className="text-muted mt-2 text-xs">
                  One submission can earn at most up to {formatViewsIndian(estimate.capViews)} views.
                </p>
              ) : null}
              <dl className="mt-5 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Budget (to clippers)</dt>
                  <dd className="tabular">{formatINR(estimate.breakdown.budgetPaise)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Platform fee ({feeBps / 100}%)</dt>
                  <dd className="tabular">{formatINR(estimate.breakdown.feePaise)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">GST on fee ({gstBps / 100}%)</dt>
                  <dd className="tabular">{formatINR(estimate.breakdown.gstPaise)}</dd>
                </div>
                <div className="border-border flex justify-between border-t pt-2 font-medium">
                  <dt>You pay</dt>
                  <dd className="tabular">{formatINR(estimate.breakdown.totalPaise)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="text-muted mt-3 text-sm">Enter a budget and rate in rupees.</p>
          )}
        </Card>
      </aside>
    </form>
  );
}
