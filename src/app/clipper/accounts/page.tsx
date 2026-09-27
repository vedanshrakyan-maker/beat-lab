import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { db } from "@/lib/db";
import { requirePageUser } from "@/lib/session";
import { getAdapter } from "@/platforms";
import { checkBioAction, connectMockAction, payoutProfileAction, startBioAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounts" };

export default async function AccountsPage() {
  const user = await requirePageUser("CLIPPER");
  const [accounts, profile] = await Promise.all([
    db.socialAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.payoutProfile.findUnique({ where: { userId: user.id } }),
  ]);
  const igMock = getAdapter("INSTAGRAM").mode === "mock";
  const ytMock = getAdapter("YOUTUBE").mode === "mock";

  return (
    <div>
      <PageHeader
        eyebrow="Clipper"
        title="Accounts & payouts"
        subtitle="Connect the accounts you post from, and where we should send your money."
      />
      <Section title="Social accounts">
        <div className="space-y-2">
          {accounts.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <div className="font-medium">@{a.handle}</div>
                <div className="text-muted text-xs">
                  {a.platform === "INSTAGRAM" ? "Instagram" : "YouTube"} ·{" "}
                  {a.followerCount.toLocaleString("en-IN")} followers · via{" "}
                  {a.verificationMethod.replace("_", " ").toLowerCase()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  tone={
                    a.status === "VERIFIED" ? "good" : a.status === "PENDING_VERIFICATION" ? "warn" : "bad"
                  }
                >
                  {a.status.replace("_", " ").toLowerCase()}
                </Badge>
                {a.status === "PENDING_VERIFICATION" && a.verificationCode ? (
                  <ActionForm action={checkBioAction} className="flex items-center gap-2 space-y-0">
                    <code className="bg-surface-2 rounded px-2 py-1 text-xs">{a.verificationCode}</code>
                    <input type="hidden" name="accountId" value={a.id} />
                    <SubmitButton size="sm" variant="secondary">
                      Check code
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </Card>
          ))}
          {accounts.length === 0 ? <p className="text-muted text-sm">No accounts connected yet.</p> : null}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card>
            <h3 className="font-serif text-lg">Connect with OAuth</h3>
            <p className="text-muted mt-1 text-sm">
              Instagram needs a <strong>professional</strong> (Creator or Business) account — personal
              accounts have no API access.
            </p>
            {igMock || ytMock ? (
              <ActionForm action={connectMockAction} className="mt-4" resetOnSuccess>
                <Field label="Platform">
                  <Select name="platform">
                    {igMock ? <option value="INSTAGRAM">Instagram (mock OAuth)</option> : null}
                    {ytMock ? <option value="YOUTUBE">YouTube (mock OAuth)</option> : null}
                  </Select>
                </Field>
                <Field label="Handle">
                  <Input name="handle" required placeholder="yourhandle" />
                </Field>
                <SubmitButton>Connect</SubmitButton>
              </ActionForm>
            ) : null}
            {!igMock ? (
              <a
                href="/api/oauth/instagram/start"
                className="text-accent mt-4 inline-block text-sm underline"
              >
                Connect Instagram professional account →
              </a>
            ) : null}
          </Card>
          <Card>
            <h3 className="font-serif text-lg">YouTube: verify with a code</h3>
            <p className="text-muted mt-1 text-sm">
              No OAuth? We give you a code to paste in your channel description; we read it through the
              YouTube API.
            </p>
            <ActionForm action={startBioAction} className="mt-4">
              <Field label="Channel handle or ID">
                <Input name="handle" required placeholder="@yourchannel" />
              </Field>
              <SubmitButton variant="secondary">Get a code</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </Section>

      <Section title="Payout details">
        <Card id="payout" className="max-w-xl">
          {profile ? (
            <dl className="mb-5 grid grid-cols-2 gap-3 text-sm">
              <dt className="text-muted">UPI ID</dt>
              <dd className="font-mono">{profile.maskedUpiId}</dd>
              <dt className="text-muted">PAN</dt>
              <dd className="font-mono">{profile.maskedPan ?? "Not provided (higher TDS rate)"}</dd>
              <dt className="text-muted">Name</dt>
              <dd>{profile.legalName}</dd>
            </dl>
          ) : null}
          <ActionForm action={payoutProfileAction}>
            <Field label="Legal name (as on PAN)">
              <Input name="legalName" required defaultValue={profile?.legalName ?? user.name ?? ""} />
            </Field>
            <Field label="UPI ID" hint="Payouts go straight to this UPI ID.">
              <Input name="upiId" required placeholder="name@okicici" autoComplete="off" />
            </Field>
            <Field
              label="PAN (optional)"
              hint="Without a verified PAN, TDS is deducted at a higher rate once it applies."
            >
              <Input name="pan" placeholder="ABCDE1234F" autoComplete="off" className="uppercase" />
            </Field>
            <SubmitButton>{profile ? "Update payout details" : "Save payout details"}</SubmitButton>
          </ActionForm>
        </Card>
      </Section>
    </div>
  );
}
