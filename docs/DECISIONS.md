# Decisions

Judgment calls made while building v0.1. Where the spec was ambiguous, the safer option was chosen.

## Stack & tooling

1. **Repository.** Built in the existing `beat-lab` repository (the session's GitHub scope) rather
   than creating a new one. Product working name: **ReelPay** (package `reelpay`).
2. **Next.js 16** (latest stable) with the App Router; no middleware — auth is checked in each page
   and server action (safer than edge middleware and simpler).
3. **Prisma 6.19** instead of Prisma 7/8: 7 requires driver adapters and a config-file migration;
   the `latest` npm tag pointed at an 8.x release candidate. Pinned the stable, well-known line.
4. **pg-boss 10** (maintained v10 line) — Postgres-backed, no Redis.
5. **Vitest 3** (Vitest 4's peer graph crashes npm 10's installer). **Playwright 1.56** to match the
   preinstalled Chromium build.
6. **Auth.js v5 (beta)** — the App Router-native line. JWT sessions (required by the dev
   Credentials provider); roles are **never** read from the session — every request re-loads the
   user from the DB.
7. **shadcn/ui-style components written by hand** (Button, Card, Badge, form fields, Table) with
   `class-variance-authority` + `tailwind-merge` — the same copy-in model shadcn uses, without the
   CLI/registry dependency. Charts are inline SVG (no chart library).
8. **System fonts** (serif headlines + sans body) instead of `next/font/google`, so builds need no
   font download.
9. **`APP_ENV`** (not `NODE_ENV`) gates production safety checks: `next build` forces
   `NODE_ENV=production`, which would otherwise make every local production build refuse dev keys.
   With `APP_ENV=production` the app refuses the dev encryption key, dev login and a dev
   `AUTH_SECRET`.
10. **Tests never run `prisma migrate reset`.** The test setup applies migrations with
    `migrate deploy` and truncates tables, and refuses any database whose name lacks `test`.

## Money & ledger

11. **Rounding**: every derived amount (fee, GST, TDS, earnings) rounds **down** to the paisa
    (in favour of the payer). To confirm with the CA for GST.
12. **Signed entries** (debit +, credit −) in a single `amountPaise` column; natural balances are
    derived per account type.
13. **Withdrawals move money to `payout_clearing` at request time** (not at batch approval), so a
    clipper can't withdraw the same balance twice while a request waits for approval. Rejection /
    failure reverses the entries.
14. **Full-balance withdrawals only** in v0.1 (partial withdrawals later). A withdrawal links the
    PAYABLE submissions it covers; they become PAID when the provider confirms.
15. **One open withdrawal per clipper** and withdrawal requests are idempotent on a
    client-generated key (double-click safe).
16. **Unused budget moves to `refund_payable` at settlement** (when every submission of an ENDED
    campaign is final), not at the moment the campaign ends — tracking posts may still earn.
17. **Clawbacks credit the campaign budget** (funder's money is restored) and debit the clipper's
    wallet, which may go negative; the clipper is flagged and withdrawals are blocked until an
    admin clears the flag.
18. **Maker-checker** on payout batches is recommended but not enforced (the seed has one admin);
    the creator and approver are both recorded. Enforce two different admins before going live.

## Lifecycle & fraud

19. **Timers live on rows, jobs are sweeps.** Instead of one pg-boss job per snapshot, each
    submission stores `nextSnapshotAt`; a per-minute pg-boss cron sweep processes everything due,
    **batched per platform** (≤50 YouTube ids per call). This is idempotent, survives lost jobs and
    keeps quota usage minimal.
20. **`reviewState` separate from `status`** so a submission in MANUAL_REVIEW keeps tracking and
    accruing (it can't become PAYABLE until cleared). AUTO_FLAG freezes accrual (status FLAGGED).
21. **Submissions needing review before approval still record snapshots**, but earn nothing until
    approved; approval catches accrual up to the latest views.
22. **PAUSED campaigns** stop new joins/submissions; posts already tracking keep accruing (fair to
    clippers who already posted). Budget exhaustion is what stops spending.
23. **Payable views = min(locked views, hold-end views).** Small drops reduce the payout (with an
    explanation); large drops flag.
24. **Below `minViewsToQualify`** at hold end → REJECTED with the reason (no fraud implied).
25. **Device fingerprint = IP hash AND user-agent hash.** IP alone is too noisy in India (mobile
    CGNAT, colleges). Fingerprints are recorded on sign-in-adjacent actions (join, submit, payout
    profile, withdraw), not on every page view.
26. **Duplicate posts** are blocked by the `(platform, platformPostId)` unique constraint; attempts
    are recorded (`DuplicateAttempt`) and feed a low-weight rule.
27. **Negative account age** (bad data) is ignored by SMALL_ACCOUNT_OUTLIER rather than guessed.
28. **Mock payout outcome is encoded in the provider payout id** (UPI containing "fail" → FAILED),
    so the web process and the worker agree without shared memory.

## Product

29. **New sign-ups get the CLIPPER role.** Creating an organization adds FUNDER. Users can hold
    several roles (the seeded creator both funds and clips).
30. **Managed campaigns** are created by admins for an organization (`isManaged`); the funder funds
    them from their dashboard as usual.
31. **Dev time travel** (`domain/devtools.ts`) makes the weeks-long lifecycle demoable: it shifts a
    submission into the past and replays the real lifecycle code with the MockAdapter. The seed and
    the E2E test use it. Disabled in production.
32. **Seed builds data through the domain layer** (funding webhooks, submissions, lifecycle,
    payouts) instead of inserting rows, so the demo ledger verifies by construction. Seed
    submissions are replayed in submission-time order to approximate first-come-first-served.
33. **i18n**: user-facing strings for navigation, landing, statuses and notifications live in
    `src/i18n/en.ts`; some page-level copy is still inline JSX and should be moved before adding
    Hindi (tracked in ROADMAP).
34. **Evidence uploads** are stored on local disk (`./uploads`) in v0.1.
35. **Razorpay Checkout widget** is not wired (mock checkout only); the Orders/Payouts/webhook
    server side is implemented as a skeleton.
36. **PLATEAU_AT_CAP requires a jump into the cap band** (`plateauEntryMinGrowth`, default 10%).
    The first version flagged genuine viral clips whose natural total happened to land within 2%
    of the cap (found via an intermittent integration test; confirmed at 75% of such clips).
