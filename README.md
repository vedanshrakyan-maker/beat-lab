# ReelPay — performance-based content rewards for India (prototype v0.1)

A two-sided marketplace. **Funders** (creators, podcasts, D2C brands) deposit a budget and set a
rate per 1,000 verified views. **Clippers** post short clips or UGC on their own Instagram Reels /
YouTube Shorts, submit the link, and earn per verified view until the budget runs out. The
platform verifies views, detects fraud (with a plain-English reason for every blocked rupee),
pays clippers over UPI with TDS, and charges a platform fee **on top** of the budget.

> "ReelPay" is a working name. Everything external (Instagram, YouTube, Razorpay, email) runs
> against **mocks by default** — no API keys needed to run the whole product locally.

## 5-minute local setup

Requirements: Node 22+, Docker (for Postgres).

```bash
cp .env.example .env                 # dev-only defaults, all integrations mocked
docker compose up -d                 # Postgres 16 on :5432 (also creates reelpay_test)
npm install
npm run db:reset                     # migrate + seed a realistic demo world (~45s)
npm run dev                          # http://localhost:3000
npm run worker                       # second terminal: background jobs (pg-boss)
```

Sign in at <http://localhost:3000/signin> with the **dev switcher** (development only). Magic-link
emails are printed in the `npm run dev` console.

## Demo walkthrough

**Funder** — `host@desifounders.local` (The Desi Founders Podcast)

1. _Funder_ → your campaigns. Open "Desi Founders: the best startup moments" — verified views,
   spend, effective cost per 1K, top clips, and the **Fraud blocked** panel (₹ saved, views
   rejected, the reasons in plain English). _Export CSV_ downloads the results report.
2. _New campaign_ → the 4-step wizard with a live estimate ("₹1,00,000 at ₹30 per 1K ≈ 33.3 lakh
   views", fee and GST). Create → _Pay_ → mock checkout → the signed webhook activates it.

**Clipper** — `aarav@clipper.local` (or any `*@clipper.local`)

1. _Clipper_ → onboarding checklist and balances. _Accounts_ → connect Instagram/YouTube (mock
   OAuth) and add UPI + PAN (encrypted; shown masked).
2. _Campaigns_ → join → paste a link, e.g. `https://www.instagram.com/reel/Cabc123xyz/` (in dev you
   can append `?mock=botted_spike` or pick a mock scenario to see the fraud engine react).
3. _My submissions_ → status timeline, views chart, estimated vs confirmed earnings, rejection
   reasons, screen-recording upload for manual verification. _Wallet_ → withdraw; TDS shown.

**Admin** — `admin@reelpay.local`

1. _Review queue_ sorted by fraud score → open one: every signal with its explanation and evidence,
   the snapshot chart, the ledger postings; approve / reject / void (reason required), enter manual
   metrics, and (dev) **time travel** a submission forward to watch lock → hold → payable.
2. _Payouts_ → create a batch from pending withdrawals, review gross/TDS/net, approve & send, sync.
3. _Campaigns_ (managed campaigns, refunds), _Settings & tax_ (fraud weights, thresholds, fees, TDS
   rules — all audited), _Audit log_, and the _Overview_ health panel (job queues, API quota, last
   ledger verification).

## Scripts

| Script                          | What it does                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `dev` / `build` / `start`       | Next.js app                                                                                        |
| `worker`                        | pg-boss worker: metrics polling, lock, hold-end, payouts sync, emails, token refresh, ledger check |
| `test`                          | Vitest unit + integration tests (uses `TEST_DATABASE_URL`, a `*_test` database)                    |
| `test:e2e`                      | Playwright smoke tests incl. the full funder → clipper → payout loop (needs a fresh seed)          |
| `lint` / `typecheck` / `format` | ESLint, `tsc --noEmit`, Prettier                                                                   |
| `db:migrate` / `db:deploy`      | `prisma migrate dev` / `prisma migrate deploy`                                                     |
| `db:seed`                       | Empties the database and seeds the demo world (refuses when `APP_ENV=production`)                  |
| `db:reset`                      | `prisma migrate reset` + seed                                                                      |
| `ledger:verify`                 | Double-entry integrity check (exit 1 on failure; runs in CI)                                       |
| `fraud:simulate`                | Runs every mock fraud scenario through the engine; CI acceptance gate                              |
| `youtube:check -- <url>`        | Calls the **live** YouTube Data API with `YOUTUBE_API_KEY`                                         |

## What's where

```
src/
  app/            Next.js App Router pages, server actions, route handlers (webhooks, OAuth, CSV)
  domain/         Business logic: campaigns, funding, submissions, lifecycle, accrual, review,
                  payouts, tax, analytics, devtools (time travel)
  ledger/         Double-entry ledger + integrity verifier
  fraud/          Rule engine: 10 pure rules, scoring, simulation harness
  platforms/      Adapter interface + Mock / YouTube / Instagram / X-stub adapters
  payments/       Provider interface + Mock / Razorpay skeleton
  jobs/           pg-boss job definitions + worker entry point
  lib/            money (integer paise), crypto (AES-256-GCM), settings, audit, session/RBAC
  i18n/           All user-facing strings (English; ready for Hindi/regional)
prisma/           Schema, migrations, seed
tests/            Unit + DB integration tests      e2e/  Playwright
docs/             Architecture, ledger, fraud, platforms, compliance, decisions, roadmap
```

Read next: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/LEDGER.md](docs/LEDGER.md) ·
[docs/FRAUD.md](docs/FRAUD.md) · [docs/PLATFORMS.md](docs/PLATFORMS.md) ·
[docs/COMPLIANCE.md](docs/COMPLIANCE.md) · [docs/DECISIONS.md](docs/DECISIONS.md) ·
[docs/ROADMAP.md](docs/ROADMAP.md)

## Engineering rules this codebase enforces

- Money is **integer paise** (`bigint`) everywhere; `money.ts` is the only place it is formatted.
- Every rupee moves through the **double-entry ledger** with an **idempotency key**.
- Budget reservation runs under `SELECT … FOR UPDATE`; a 50-way concurrency test proves it
  can't be overspent.
- PAN, UPI IDs and OAuth tokens are **AES-256-GCM encrypted**, shown masked, never logged.
- Every admin action and state change is **audit-logged**; every admin review decision is stored
  as a training label.
- Tax rules, fees and fraud thresholds are **configuration**, editable in the admin panel.
- No scraping: official APIs or the manual-verification fallback only.
