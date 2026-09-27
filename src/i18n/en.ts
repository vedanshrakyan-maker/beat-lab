/**
 * English strings. Every user-facing string goes here so Hindi and regional-language
 * dictionaries can be added later (ROADMAP) without touching components.
 * Interpolation: "{name}".
 */
export const en = {
  "app.name": "ReelPay",
  "app.tagline": "Get paid for every verified view.",

  "nav.campaigns": "Campaigns",
  "nav.clipper": "Clipper",
  "nav.funder": "Funder",
  "nav.admin": "Admin",
  "nav.wallet": "Wallet",
  "nav.submissions": "My submissions",
  "nav.accounts": "Accounts",
  "nav.notifications": "Notifications",
  "nav.signIn": "Sign in",
  "nav.signOut": "Sign out",
  "nav.dashboard": "Dashboard",

  "landing.hero.title": "Performance-based content rewards, built for India.",
  "landing.hero.subtitle":
    "Funders pay only for verified views. Clippers earn per 1,000 views, straight to UPI. Every rejected rupee comes with a reason.",
  "landing.cta.browse": "Browse campaigns",
  "landing.cta.fund": "Launch a campaign",
  "landing.funders.title": "For funders",
  "landing.funders.1": "Deposit a budget and set a rate per 1,000 verified views.",
  "landing.funders.2": "Clippers post on Instagram Reels and YouTube Shorts.",
  "landing.funders.3":
    "Pay only for views that pass fraud checks — the fee is on top, so your whole budget reaches clippers.",
  "landing.clippers.title": "For clippers",
  "landing.clippers.1": "Connect your Instagram or YouTube account.",
  "landing.clippers.2": "Join a campaign, post a clip, paste the link.",
  "landing.clippers.3": "Earn for every verified view. Withdraw to UPI; TDS shown upfront.",
  "landing.fraud.title": "Fraud protection you can see",
  "landing.fraud.body":
    "Ten fraud rules watch every post: bought-view spikes, looping, views that vanish after lock, linked accounts and more. Every reduced or rejected payout carries a plain-English reason.",

  "campaign.status.DRAFT": "Draft",
  "campaign.status.PENDING_FUNDING": "Awaiting funding",
  "campaign.status.ACTIVE": "Active",
  "campaign.status.PAUSED": "Paused",
  "campaign.status.EXHAUSTED": "Budget exhausted",
  "campaign.status.ENDED": "Ended",
  "campaign.status.SETTLED": "Settled",
  "campaign.ratePer1k": "per 1K views",
  "campaign.budgetRemaining": "{remaining} of {budget} left",
  "campaign.join": "Join campaign",
  "campaign.joined": "You're in",
  "campaign.submit": "Submit a post",

  "submission.status.SUBMITTED": "Submitted",
  "submission.status.UNDER_REVIEW": "Under review",
  "submission.status.APPROVED": "Approved",
  "submission.status.TRACKING": "Tracking",
  "submission.status.LOCKED": "Locked",
  "submission.status.HELD": "On hold",
  "submission.status.PAYABLE": "Payable",
  "submission.status.PAID": "Paid",
  "submission.status.REJECTED": "Rejected",
  "submission.status.FLAGGED": "Flagged",
  "submission.status.VOIDED": "Voided",
  "submission.status.CLAWED_BACK": "Clawed back",

  "payout.status.PENDING": "Requested",
  "payout.status.APPROVED": "Approved",
  "payout.status.PROCESSING": "Processing",
  "payout.status.PAID": "Paid",
  "payout.status.FAILED": "Failed",
  "payout.status.REVERSED": "Reversed",
  "payout.status.REJECTED": "Rejected",

  "notify.SUBMISSION_APPROVED.title": "Submission approved",
  "notify.SUBMISSION_APPROVED.body":
    "Your post for “{campaign}” is approved and we're now tracking its views.",
  "notify.SUBMISSION_REJECTED.title": "Submission rejected",
  "notify.SUBMISSION_REJECTED.body": "Your post for “{campaign}” was rejected: {reason}",
  "notify.SUBMISSION_UNDER_REVIEW.title": "Submission under review",
  "notify.SUBMISSION_UNDER_REVIEW.body":
    "Your post for “{campaign}” needs a quick manual review. Tracking continues meanwhile.",
  "notify.BUDGET_LOW.title": "Budget almost exhausted",
  "notify.BUDGET_LOW.body": "“{campaign}” has {remaining} of budget left.",
  "notify.BUDGET_EXHAUSTED.title": "Campaign budget exhausted",
  "notify.BUDGET_EXHAUSTED.body": "“{campaign}” has used its full budget. New views no longer earn.",
  "notify.EARNINGS_PAYABLE.title": "Earnings cleared",
  "notify.EARNINGS_PAYABLE.body": "{amount} from “{campaign}” is now in your wallet and ready to withdraw.",
  "notify.PAYOUT_SENT.title": "Payout sent",
  "notify.PAYOUT_SENT.body": "{amount} was sent to {upi} (TDS withheld: {tds}).",
  "notify.PAYOUT_FAILED.title": "Payout failed",
  "notify.PAYOUT_FAILED.body": "Your payout of {amount} failed: {reason}. The amount is back in your wallet.",
  "notify.ACCOUNT_FLAGGED.title": "Account flagged",
  "notify.ACCOUNT_FLAGGED.body":
    "Your account was flagged for review: {reason}. Withdrawals are paused until it is resolved.",
  "notify.ACCOUNT_DISCONNECTED.title": "Social account disconnected",
  "notify.ACCOUNT_DISCONNECTED.body":
    "We lost access to {handle}. Reconnect it so we can keep tracking your views.",
  "notify.CAMPAIGN_ACTIVE.title": "Campaign live",
  "notify.CAMPAIGN_ACTIVE.body": "“{campaign}” is funded and live. Clippers can join now.",
} as const;

export type MessageKey = keyof typeof en;
