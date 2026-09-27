import type { CampaignStatus, PayoutStatus, SubmissionStatus } from "@prisma/client";
import { Badge, type Tone } from "@/components/ui/badge";
import { t, type MessageKey } from "@/i18n";

const submissionTone: Record<SubmissionStatus, Tone> = {
  SUBMITTED: "neutral",
  UNDER_REVIEW: "warn",
  APPROVED: "accent",
  TRACKING: "accent",
  LOCKED: "neutral",
  HELD: "neutral",
  PAYABLE: "good",
  PAID: "good",
  REJECTED: "bad",
  FLAGGED: "bad",
  VOIDED: "bad",
  CLAWED_BACK: "bad",
};

const campaignTone: Record<CampaignStatus, Tone> = {
  DRAFT: "neutral",
  PENDING_FUNDING: "warn",
  ACTIVE: "good",
  PAUSED: "warn",
  EXHAUSTED: "bad",
  ENDED: "neutral",
  SETTLED: "neutral",
};

const payoutTone: Record<PayoutStatus, Tone> = {
  PENDING: "warn",
  APPROVED: "accent",
  PROCESSING: "accent",
  PAID: "good",
  FAILED: "bad",
  REVERSED: "bad",
  REJECTED: "bad",
};

export function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  return <Badge tone={submissionTone[status]}>{t(`submission.status.${status}` as MessageKey)}</Badge>;
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge tone={campaignTone[status]}>{t(`campaign.status.${status}` as MessageKey)}</Badge>;
}

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return <Badge tone={payoutTone[status]}>{t(`payout.status.${status}` as MessageKey)}</Badge>;
}

export function PlatformBadge({ platform }: { platform: string }) {
  return (
    <Badge tone="neutral">
      {platform === "INSTAGRAM" ? "Instagram Reels" : platform === "YOUTUBE" ? "YouTube Shorts" : platform}
    </Badge>
  );
}

export function FraudScoreBadge({ score }: { score: number }) {
  const tone: Tone = score >= 70 ? "bad" : score >= 30 ? "warn" : "good";
  return <Badge tone={tone}>Risk {score}</Badge>;
}
