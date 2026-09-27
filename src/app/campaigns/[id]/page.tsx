import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader } from "@/components/page";
import { CampaignStatusBadge, PlatformBadge } from "@/components/status";
import { LinkButton } from "@/components/ui/button";
import { Card, Stat } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { acceptsSubmissions, parseRules } from "@/domain/campaigns";
import { capViewsFor } from "@/domain/accrual";
import { campaignCards } from "@/domain/queries";
import { devtoolsEnabled } from "@/domain/devtools";
import { db } from "@/lib/db";
import { formatINR, formatINRCompact, formatViewsIndian } from "@/lib/money";
import { getCurrentUser } from "@/lib/session";
import { isMockPlatform } from "@/platforms";
import { mockScenarios } from "@/platforms/mock";
import { joinAction } from "./actions";
import { SubmitForm } from "./submit-form";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [c] = await campaignCards({ id });
  if (!c || c.status === "DRAFT" || c.status === "PENDING_FUNDING") notFound();
  const user = await getCurrentUser();
  const rules = parseRules(c.rules);
  const capViews = capViewsFor(c);
  const open = acceptsSubmissions(c);
  const participation = user
    ? await db.campaignParticipation.findUnique({
        where: { campaignId_clipperId: { campaignId: c.id, clipperId: user.id } },
      })
    : null;
  const accounts = user
    ? await db.socialAccount.findMany({
        where: { userId: user.id, status: "VERIFIED", platform: { in: c.allowedPlatforms } },
      })
    : [];
  const showScenarios = devtoolsEnabled() && c.allowedPlatforms.some((p) => isMockPlatform(p));

  const ruleRows: [string, string][] = [
    ["Required hashtags", rules.requiredHashtags.join(" ") || "None"],
    ["Required mentions", rules.requiredMentions.join(" ") || "None"],
    [
      "Duration",
      rules.minDurationSec || rules.maxDurationSec
        ? `${rules.minDurationSec ?? 0}–${rules.maxDurationSec ?? "∞"} seconds`
        : "Any (Shorts ≤ 3 min)",
    ],
    ["Languages", rules.languages.join(", ") || "Any"],
    ["Fan pages", rules.allowFanPages ? "Allowed" : "Not allowed — post from your personal creator account"],
    ["Minimum views to earn", c.minViewsToQualify ? c.minViewsToQualify.toLocaleString("en-IN") : "None"],
    [
      "Max per submission",
      c.maxPayoutPerSubmissionPaise
        ? `${formatINR(c.maxPayoutPerSubmissionPaise)} (${formatViewsIndian(capViews ?? 0)} views)`
        : "No cap",
    ],
    ["Max per clipper", c.maxPayoutPerClipperPaise ? formatINR(c.maxPayoutPerClipperPaise) : "No cap"],
    [
      "Tracking & hold",
      `Views tracked for ${c.trackingWindowDays} days, then held ${c.holdPeriodDays} days before payout`,
    ],
  ];

  return (
    <div>
      <PageHeader
        eyebrow={`${c.category} · ${c.type === "CLIPPING" ? "Clipping campaign" : "UGC campaign"}`}
        title={c.title}
        actions={<CampaignStatusBadge status={c.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Rate"
              value={formatINR(c.ratePer1kViewsPaise)}
              hint="per 1,000 verified views"
              accent
            />
            <Stat
              label="Budget left"
              value={formatINRCompact(c.remainingPaise)}
              hint={`of ${formatINRCompact(c.budgetPaise)}`}
            />
            <Stat label="Clippers" value={c.clipperCount} hint={`${c.submissionCount} posts submitted`} />
          </div>
          <Progress value={c.remainingPaise} max={c.budgetPaise} />
          <Card>
            <p className="text-fg/90 whitespace-pre-line">{c.description}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {c.allowedPlatforms.map((p) => (
                <PlatformBadge key={p} platform={p} />
              ))}
            </div>
          </Card>
          {c.sourceContentUrls.length ? (
            <Card>
              <h2 className="mb-3 font-serif text-xl">Source content to clip</h2>
              <ul className="space-y-1 text-sm">
                {c.sourceContentUrls.map((u) => (
                  <li key={u}>
                    <a
                      href={u}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent break-all underline"
                    >
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card>
            <h2 className="mb-3 font-serif text-xl">Rules</h2>
            <dl className="divide-border divide-y text-sm">
              {ruleRows.map(([k, v]) => (
                <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[200px_1fr]">
                  <dt className="text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {rules.disallowedContent.length ? (
              <p className="text-bad mt-3 text-sm">Not allowed: {rules.disallowedContent.join(" · ")}</p>
            ) : null}
            {rules.notes ? <p className="text-muted mt-3 text-sm">{rules.notes}</p> : null}
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card className="p-6">
            {!open ? (
              <p className="text-muted text-sm">This campaign isn&apos;t accepting new posts right now.</p>
            ) : !user ? (
              <div className="space-y-3">
                <p className="text-muted text-sm">Sign in as a clipper to join.</p>
                <LinkButton href="/signin" className="w-full">
                  Sign in
                </LinkButton>
              </div>
            ) : !user.roles.includes("CLIPPER") ? (
              <p className="text-muted text-sm">Only clipper accounts can join campaigns.</p>
            ) : participation?.status !== "ACTIVE" ? (
              <ActionForm action={joinAction}>
                <input type="hidden" name="campaignId" value={c.id} />
                <p className="text-muted text-sm">
                  Join to submit posts. You earn {formatINR(c.ratePer1kViewsPaise)} for every 1,000 verified
                  views.
                </p>
                <SubmitButton className="w-full">Join campaign</SubmitButton>
              </ActionForm>
            ) : accounts.length === 0 ? (
              <div className="space-y-3">
                <p className="text-muted text-sm">
                  Connect a verified {c.allowedPlatforms.map((p) => p.toLowerCase()).join(" or ")} account
                  first.
                </p>
                <LinkButton href="/clipper/accounts" className="w-full">
                  Connect account
                </LinkButton>
              </div>
            ) : (
              <div>
                <h2 className="mb-4 font-serif text-xl">Submit a post</h2>
                <SubmitForm
                  campaignId={c.id}
                  accounts={accounts.map((a) => ({
                    id: a.id,
                    label: `@${a.handle} · ${a.platform === "INSTAGRAM" ? "Instagram" : "YouTube"}`,
                  }))}
                  scenarios={showScenarios ? [...mockScenarios] : null}
                />
              </div>
            )}
          </Card>
          {participation ? (
            <Link href="/clipper/submissions" className="text-muted hover:text-fg block text-center text-sm">
              Your submissions →
            </Link>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
