# Ledger

Every rupee movement is a `LedgerTransaction` with ≥2 `LedgerEntry` rows that **sum to zero**
(positive = debit, negative = credit) and a **unique idempotency key**. Balances are always
derived by summing entries (`ledger/ledger.ts: balance()`); caches such as
`Submission.earnedPaise` are verified against the ledger by `npm run ledger:verify`.

Amounts are integer paise (`BigInt` columns). "Natural balance" = debit-positive for assets,
credit-positive for liabilities and revenue.

## Accounts

| Code                              | Type      | Meaning                                                                             |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `funder_cash_in`                  | asset     | Cash received from funders via the payment provider (and not yet paid out/refunded) |
| `campaign_budget:{campaignId}`    | liability | Clipper-facing budget still available                                               |
| `campaign_reserved:{campaignId}`  | liability | Earnings accrued but not yet payable                                                |
| `platform_fee_revenue`            | revenue   | Platform fee                                                                        |
| `gst_payable`                     | liability | GST collected on the fee                                                            |
| `clipper_payable:{userId}`        | liability | Cleared earnings owed to a clipper (may go negative after a clawback)               |
| `tds_payable`                     | liability | TDS withheld, owed to the government                                                |
| `payout_clearing`                 | liability | Committed to withdrawals, awaiting provider confirmation                            |
| `refund_payable:{organizationId}` | liability | Unused budget owed back to a funder                                                 |

## Flows (examples: ₹1,00,000 budget, 10% fee, 18% GST, ₹30 per 1K views)

**1. Funding** (only on a signature-verified, idempotent provider webhook; campaign → ACTIVE)

```
Dr funder_cash_in            1,11,800.00
   Cr campaign_budget:c       1,00,000.00
   Cr platform_fee_revenue       10,000.00
   Cr gst_payable                 1,800.00      key funding:{fundingPaymentId}
```

The fee is **on top** of the budget: the clipper-facing pool is the full ₹1,00,000.

**2. Accrual** (every snapshot; moves only the delta; key `accrual:{submissionId}:{slot}`)

```
views 20,000 → target ₹600; already reserved ₹450 → delta ₹150
Dr campaign_budget:c    150.00
   Cr campaign_reserved:c   150.00
```

`target = floor(min(views, cap views) × rate / 1000)`, then capped by the per-clipper cap and by
the remaining budget. Runs inside the caller's transaction after
`SELECT … FROM "Campaign" WHERE id = $1 FOR UPDATE`, so concurrent accruals on one campaign are
serialized. **Allocation is first-come-first-served by accrual time**: when the budget hits zero
the campaign becomes EXHAUSTED and later views earn nothing (funders and participants are
notified). A test fires 50 parallel accruals at a nearly empty campaign and asserts the budget
ends at exactly zero.

**3. Clearing** (hold ended clean; key `clearing:{submissionId}`)

```
Dr campaign_reserved:c     600.00
   Cr clipper_payable:u        600.00
```

If views fell between lock and hold end, payable views = min(locked, hold-end) and the difference
is first released back to the budget (`RELEASE`, key `holdadjust:{submissionId}`) with an
explanation shown to the clipper.

**4. Void / clawback**

- Before clearing (`RELEASE`, key `void:{id}`): `Dr campaign_reserved / Cr campaign_budget`.
- After clearing or payment (`CLAWBACK`, key `clawback:{id}`):
  `Dr clipper_payable:u / Cr campaign_budget:c`. The wallet may go negative; it is offset against
  future earnings, and the clipper is flagged (withdrawals blocked).
- Returned budget re-activates an EXHAUSTED campaign.

**5. Payouts** (withdraw the full payable balance; minimum ₹500, configurable)

```
request (key payout_request:{payoutId}):
Dr clipper_payable:u   10,000.00
   Cr tds_payable            1,000.00
   Cr payout_clearing        9,000.00
paid (key payout_paid:{payoutId}):
Dr payout_clearing      9,000.00
   Cr funder_cash_in        9,000.00
failed / rejected / reversed (key payout_reversal:{payoutId}): the request entries reversed
(or, for a reversal after PAID, cash comes back instead of clearing).
```

Provider calls carry `Payout.idempotencyKey` (RazorpayX `X-Payout-Idempotency`), so retries can
never pay twice. The withdrawal request itself is idempotent on a client-generated key.

**6. Campaign end** (settle sweep; key `campaign_end:{campaignId}:{n}`)

```
Dr campaign_budget:c    remaining
   Cr refund_payable:org     remaining
```

Refunds are an admin action in v0.1 (`REFUND_PAID`: `Dr refund_payable / Cr funder_cash_in`).

## Invariants (`npm run ledger:verify`, daily job, CI against seed data)

1. Every transaction sums to zero; every transaction has ≥2 entries.
2. No negative balance on budget, reserved, clearing, TDS, GST, fee, refund or cash accounts
   (the budget can never be overspent).
3. Funding, fee and GST match `FundingPayment` rows marked PAID (per campaign and in total).
4. `campaign_reserved` per campaign = Σ `earnedPaise` of submissions still in reserved states.
5. Each submission's `earnedPaise` = accruals − releases − clawbacks from the ledger.
6. `payout_clearing` = net of in-flight payouts; `tds_payable` = TDS on non-failed payouts.
7. Cash = funding received − payouts paid − refunds.

## Custody

The ledger models money held by the platform. If custody moves to an escrow/nodal account
(docs/COMPLIANCE.md), `funder_cash_in` maps to that account; business logic does not change.
