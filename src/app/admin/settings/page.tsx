import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { db } from "@/lib/db";
import { formatINR } from "@/lib/money";
import { getSetting, settingRegistry, type SettingKey } from "@/lib/settings";
import { formatDate } from "@/lib/utils";
import { settingAction, taxRuleAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const keys = Object.keys(settingRegistry) as SettingKey[];
  const values = await Promise.all(keys.map(async (k) => [k, await getSetting(k)] as const));
  const rows = await db.setting.findMany();
  const rules = await db.taxRule.findMany({ orderBy: { effectiveFrom: "desc" } });
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Settings"
        subtitle="Every threshold is configuration. Changes are validated and audit-logged."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {values.map(([key, value]) => {
          const row = rows.find((r) => r.key === key);
          return (
            <Card key={key}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium">{settingRegistry[key].label}</h3>
                <span className="text-muted text-xs">
                  {row ? `updated ${formatDate(row.updatedAt, true)}` : "defaults"}
                </span>
              </div>
              <ActionForm action={settingAction} className="mt-3">
                <input type="hidden" name="key" value={key} />
                <Textarea
                  name="value"
                  defaultValue={JSON.stringify(value, null, 2)}
                  className="min-h-72 font-mono text-xs"
                  spellCheck={false}
                />
                <SubmitButton size="sm" variant="secondary">
                  Save
                </SubmitButton>
              </ActionForm>
            </Card>
          );
        })}
      </div>

      <Section title="Tax rules (TDS)">
        <p className="text-muted mb-4 max-w-3xl text-sm">
          Rates, thresholds and section labels are data, never code. India&apos;s Income-tax Act, 2025 (from 1
          April 2026) renumbered TDS provisions — confirm every value with a CA.
        </p>
        <div className="space-y-4">
          {[...rules, null].map((r) => (
            <Card key={r?.id ?? "new"}>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="font-medium">{r ? r.name : "New rule"}</h3>
                {r ? (
                  <Badge tone={r.active ? "good" : "neutral"}>{r.active ? "active" : "inactive"}</Badge>
                ) : null}
                {r ? (
                  <span className="text-muted text-xs">
                    {(r.ratePctBps / 100).toFixed(2)}% · {(r.rateWithoutPanBps / 100).toFixed(2)}% without PAN
                    · threshold {formatINR(r.annualThresholdPaise)}/FY
                  </span>
                ) : null}
              </div>
              <ActionForm action={taxRuleAction}>
                <input type="hidden" name="id" value={r?.id ?? ""} />
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Name">
                    <Input name="name" defaultValue={r?.name ?? ""} required />
                  </Field>
                  <Field label="Section label (free text)">
                    <Input name="sectionLabel" defaultValue={r?.sectionLabel ?? ""} required />
                  </Field>
                  <Field label="Rate (bps)" hint="1000 = 10%">
                    <Input name="ratePctBps" type="number" defaultValue={r?.ratePctBps ?? 1000} required />
                  </Field>
                  <Field label="Rate without PAN (bps)">
                    <Input
                      name="rateWithoutPanBps"
                      type="number"
                      defaultValue={r?.rateWithoutPanBps ?? 2000}
                      required
                    />
                  </Field>
                  <Field label="Annual threshold (paise)">
                    <Input
                      name="annualThresholdPaise"
                      defaultValue={r?.annualThresholdPaise.toString() ?? "3000000"}
                      required
                    />
                  </Field>
                  <Field label="Per-payment threshold (paise)" hint="Blank = none">
                    <Input
                      name="perTransactionThresholdPaise"
                      defaultValue={r?.perTransactionThresholdPaise?.toString() ?? ""}
                    />
                  </Field>
                  <Field label="Effective from">
                    <Input
                      name="effectiveFrom"
                      type="date"
                      defaultValue={iso(r?.effectiveFrom ?? new Date())}
                      required
                    />
                  </Field>
                  <Field label="Effective to">
                    <Input name="effectiveTo" type="date" defaultValue={iso(r?.effectiveTo ?? null)} />
                  </Field>
                  <label className="flex items-center gap-2 pt-6 text-sm">
                    <input type="checkbox" name="active" defaultChecked={r?.active ?? true} /> Active
                  </label>
                </div>
                <Field label="Notes">
                  <Input name="notes" defaultValue={r?.notes ?? ""} />
                </Field>
                <SubmitButton size="sm" variant="secondary">
                  {r ? "Save rule" : "Add rule"}
                </SubmitButton>
              </ActionForm>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
