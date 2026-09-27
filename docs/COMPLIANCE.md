# Compliance — open questions for a CA and a lawyer

**This prototype is not legal or tax advice. Nothing here is final.** Every item below must be
reviewed by a Chartered Accountant and a lawyer before handling real money.

## 1. Funds custody, payment aggregation and escrow

ReelPay collects funders' budgets and later pays third parties (clippers). Holding and routing
third-party funds as a marketplace may bring **payment-aggregator** obligations under RBI rules, or
require an **escrow/nodal** arrangement.

- Is ReelPay a payment aggregator, or can it operate under a licensed PA's escrow product
  (e.g. **Razorpay Escrow+**, or a bank escrow account)? Evaluate before launch.
- Who legally owns unspent budget, and within what time must it be refunded?
- Design note: the ledger (docs/LEDGER.md) treats `funder_cash_in` as "money held"; moving custody
  to an escrow account changes where that account lives, not the business logic.

## 2. TDS on payments to clippers

- Which TDS provision applies to clipper payouts? Creator payments have historically been treated
  under different provisions (professional/technical fees, contract work, or others) depending
  on how the contract is structured.
- **India's Income-tax Act, 2025 is in force from 1 April 2026 and renumbered the TDS provisions.**
  The code never hardcodes section numbers, rates or thresholds: they live in the `TaxRule` table
  (Admin → Settings & tax). The seeded rule is labelled **"Professional/contract fees — CONFIRM WITH
  CA"** and its values (10%, 20% without PAN, ₹30,000/FY threshold) are **placeholders**.
- Current engine behaviour to confirm: threshold is checked on financial-year cumulative gross
  payouts (IST, April–March); once crossed, TDS applies to the payout that crosses it (not
  retroactively to earlier payouts); the higher rate applies if PAN is missing or unverified.
- Deposit timelines, TDS returns and certificates to clippers are not built (statement CSV only).

## 3. GST

- GST on the platform fee (default 18%, configurable). Confirm the rate/classification of the
  service, place of supply, and invoicing requirements (GSTIN capture exists on organizations).
- Is any GST due on the budget portion (pass-through) under the chosen custody model?
- Do clippers who cross the GST registration threshold need to invoice ReelPay?

## 4. Data protection (DPDP Act, 2023)

PAN, UPI IDs and OAuth tokens are encrypted at rest (AES-256-GCM), masked in the UI, never logged;
IPs and user agents are only stored as keyed hashes. Open questions:

- Consent notices and purpose limitation for PAN/UPI (KYC, tax) and device fingerprints (fraud).
- Retention periods (tax records must be retained; fingerprints should expire), data-principal
  rights (access, correction, erasure) and grievance officer.
- Key management: move `ENCRYPTION_KEY` to a KMS with rotation (ciphertexts are versioned `v1.`).
- Cross-border transfer if infrastructure is outside India.

## 5. Clipper terms of service

- Payout conditions: verification, hold period, caps, first-come-first-served budget, clawbacks
  and set-off against future earnings (the ledger already models negative balances).
- Prohibited conduct: bought views, bots, looping, multi-accounting, deleting posts after payout.
- Relationship: independent contractor, tax responsibilities, PAN requirement.
- Disclosure: paid-promotion labelling (ASCI influencer guidelines) and platform branded-content
  policies — likely a required-hashtag default such as `#ad`.

## 6. Content rights for clipping

- Funders must warrant they own (or license) the source content and grant clippers a licence to
  cut, caption and post it on their own accounts; guest/third-party rights inside podcasts.
- Takedown handling (copyright claims on clipped posts), music licensing inside clips.
- Moral rights / misrepresentation of guests (the seed campaign bans "misquoting guests").

## 7. Platform terms

- Instagram and YouTube developer policies (data use, storage limits, display requirements).
  Meta App Review and Google OAuth verification are prerequisites for live use.
- No scraping anywhere (by design).
