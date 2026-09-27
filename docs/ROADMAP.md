# Roadmap

## Before a paid pilot

- Legal/CA sign-off on everything in COMPLIANCE.md (custody/escrow, TDS classification, GST).
- Meta App Review for Instagram insights; Google OAuth verification; YouTube quota plan.
- Wire Razorpay Checkout (UPI Intent/QR) and RazorpayX payouts end-to-end with test keys.
- Enforce maker-checker on payout batches; alerting on failed jobs and ledger verification.
- KMS-managed encryption keys with rotation; S3/GCS for evidence uploads with signed URLs.
- Real SMTP/transactional email adapter.
- Move remaining inline page copy into `src/i18n` (then add Hindi).

## Next features

- **Partial withdrawals** and scheduled automatic payouts for trusted clippers.
- **Clipper trust tiers**: longer holds for new clippers, faster payouts for trusted ones
  (`TrustTierPolicy` interface in `src/fraud/later.ts`).
- **Fraud v2**: perceptual hashing of thumbnails/frames to catch re-uploads, audience geography
  mismatch, bot-comment classifier; then an **ML scorer trained on `ReviewDecision` labels**
  (every admin decision since day one is stored with the signals as features).
- PDF results reports for funders; funder top-ups for running campaigns.
- Funder-side review (funders flag clips they dislike, within the rules).

## Seams left for expansion (don't build yet)

- **More platforms** (X, Moj, ShareChat) as new `PlatformAdapter`s — the X stub shows the shape.
- **Creator storefronts** (courses, communities) — the long-term expansion; organizations and the
  ledger already model funders as merchants.
- **Referral / affiliate tracking** alongside view-based payouts (a new accrual source posting to
  the same ledger accounts).
- **Multi-currency / international**: money is integer minor units; add a currency column to
  ledger accounts before the first non-INR campaign.
- **Public API for agencies** running many campaigns (domain functions are already UI-agnostic).
- **Hindi and regional-language UI** via `src/i18n`.
