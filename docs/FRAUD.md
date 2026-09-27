# Fraud engine

Location: `src/fraud/`. The engine is the product's core IP: it decides which views are paid and
explains every decision in plain English — to admins in detail, to funders in simplified form.

## Design

- Each rule is a **pure function** `(ctx: FraudContext) => FraudSignal | null` (no I/O). The
  context holds the submission, all snapshots, the social account, the clipper's history, the
  campaign's caps and required tags, the post's existence check, linked-account counts and the
  current settings. `domain/fraud-context.ts` builds it from the DB.
- Each signal has a `score` (0–100), a `weight` and `enabled` flag from the `fraud` setting, an
  admin `explanation` with numbers, a `funderExplanation`, and structured `evidence`.
- **Combined score** = `min(100, round(Σ score × weight))`.
- **Decision bands** (configurable): `< 30` AUTO_APPROVE · `30–69` MANUAL_REVIEW · `≥ 70`
  AUTO_FLAG (earnings frozen until an admin decides). Hard actions override the score:
  a `VOID` signal → AUTO_VOID, a `REJECT` signal (at submission) → AUTO_REJECT.
- **Manual metrics are stricter**: when a submission's metrics come from an admin-entered screen
  recording, both thresholds drop by `manualStrictnessOffset` (default 10).
- The engine runs at **submission**, on **every snapshot**, at **LOCK** and at **HOLD end**. Each
  run replaces the previous signals of that phase.
- An admin "approve" stores the score it was cleared at; the same evidence doesn't re-flag it,
  only a higher score does. Every admin decision is stored in `ReviewDecision` with a snapshot of
  the signals — labelled training data for a future ML model.

## Rules (defaults)

| Rule                            | Catches                                                                                                                                                        | Score                                  | Weight  | False-positive risk & mitigation                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VELOCITY_SPIKE`                | (A) a vertical jump (≥60% of all views in ≤6h, ≥5,000/h) followed by ≤5% growth over ≥12h — bought views. (B) hourly gain ≥14× the account's historical median | A: 85, B: 20                           | 1.0     | Genuine viral clips spike too, so (B) is informational only; (A) needs the flat line after the jump, which organic virality doesn't produce.                                                                                                                |
| `LOW_ENGAGEMENT_RATIO`          | (likes+comments+shares)/views below the per-platform floor (0.3%) once views ≥ 1,000                                                                           | 50; 90 below a third of the floor      | 0.8     | Some niches (music, silent loops) engage little; the floor is per-platform and editable.                                                                                                                                                                    |
| `VIEWS_TO_REACH_RATIO`          | views/reach > 3.0 (Instagram only; reach is unique accounts)                                                                                                   | 70; 90 above 5.0                       | 1.0     | Short, highly rewatchable loops can exceed 3; tune the threshold.                                                                                                                                                                                           |
| `SMALL_ACCOUNT_OUTLIER`         | < 1,000 followers or < 30 days old, and ≥ 20,000 views and ≥ 50× followers within 24h                                                                          | 60                                     | **0.4** | Real viral moments on small accounts are common in clipping: alone it scores 24 (auto-approve); it only matters combined with other signals.                                                                                                                |
| `PLATEAU_AT_CAP`                | views **jump into** the ±2% band around the exact views that earn the per-submission max payout (≥10% growth into it) and then stall there for ≥2 snapshots    | 85                                     | 1.0     | A viral clip whose natural total saturates near the cap. Natural saturation creeps into the band, so the entry-growth condition excludes it: in a 20,000-post check, a naive "stalled near cap" rule flagged 961 of 1,288 genuine clips; this rule flags 0. |
| `DELETED_OR_PRIVATE_AFTER_LOCK` | post deleted/private at the lock or hold re-check                                                                                                              | 100, **VOID**                          | 1.0     | Platform outages: only definitive `DELETED`/`PRIVATE` voids, `UNKNOWN` never does.                                                                                                                                                                          |
| `VIEW_DROP_AFTER_LOCK`          | views fell between lock and hold end                                                                                                                           | 80 if ≥20%; 15 (payout reduced) if ≥5% | 1.0     | Platforms re-count views; small drops only reduce the payout (with an explanation).                                                                                                                                                                         |
| `DUPLICATE_SUBMISSION`          | repeated attempts to submit posts already in the system (the unique constraint blocks the duplicate itself)                                                    | 20 per attempt, max 60                 | 0.5     | Honest mistakes: one attempt scores 10.                                                                                                                                                                                                                     |
| `MULTI_ACCOUNT_LINK`            | same UPI ID / PAN (keyed-hash match) or same device fingerprint (IP **and** user-agent hash) across clipper users                                              | 90 UPI/PAN; 50 device                  | 1.0     | Families share UPI; offices/colleges share networks — hence IP alone is never used (Indian mobile CGNAT).                                                                                                                                                   |
| `RULE_VIOLATION_HINTS`          | required hashtag/mention missing from the caption (API caption/title/description)                                                                              | 100; **REJECT** at submission          | 1.0     | Captions edited after submission flag (not reject). Case-insensitive token match.                                                                                                                                                                           |

All thresholds live in the `fraud` setting (Admin → Settings), audited on every change.

## Simulation harness

`npm run fraud:simulate` drives the MockAdapter through a full lifecycle (T+0 … daily snapshots,
lock, hold end) for every scenario with 10 seeds each and runs the engine at every phase.
**Acceptance (CI gate): every clean scenario auto-approves; every fraud scenario ends AUTO_FLAG,
AUTO_VOID or AUTO_REJECT.** Current result:

| Scenario             | Expected     | Outcome                       | Main signals                              |
| -------------------- | ------------ | ----------------------------- | ----------------------------------------- |
| CLEAN_VIRAL          | clean        | AUTO_APPROVE                  | VELOCITY_SPIKE(20)                        |
| CLEAN_SLOW           | clean        | AUTO_APPROVE                  | —                                         |
| SMALL_ACCOUNT_VIRAL  | clean        | AUTO_APPROVE                  | SMALL_ACCOUNT_OUTLIER(60×0.4)             |
| BOTTED_SPIKE         | fraud        | AUTO_FLAG                     | VELOCITY_SPIKE(85) + LOW_ENGAGEMENT_RATIO |
| DELETED_AFTER_LOCK   | fraud        | AUTO_VOID                     | DELETED_OR_PRIVATE_AFTER_LOCK             |
| PLATEAU_AT_CAP       | fraud        | AUTO_FLAG                     | PLATEAU_AT_CAP(85)                        |
| LOW_ENGAGEMENT       | fraud        | AUTO_FLAG                     | LOW_ENGAGEMENT_RATIO(90×0.8)              |
| LOOPING              | fraud        | AUTO_FLAG                     | VIEWS_TO_REACH_RATIO(90)                  |
| VIEW_DROP            | fraud        | AUTO_FLAG                     | VIEW_DROP_AFTER_LOCK(80)                  |
| MISSING_HASHTAG      | fraud        | AUTO_REJECT                   | RULE_VIOLATION_HINTS                      |
| MULTI_ACCOUNT        | fraud        | AUTO_FLAG                     | MULTI_ACCOUNT_LINK(90)                    |
| INSIGHTS_UNAVAILABLE | manual queue | routed to manual verification | —                                         |

Note from the seed: a clean viral clip from a 300-follower account scores 20 + 24 = 44 and goes
to manual review. That is intended (tiny account + extreme velocity is worth a human look).

## Adding a rule

1. Add the key to `fraudRuleKeys` and a default `{ enabled, weight }` in `src/lib/settings.ts`
   (plus any thresholds).
2. Write `src/fraud/rules/<name>.ts` exporting a `FraudRule` — pure, with an admin explanation that
   includes the numbers and a funder-safe explanation.
3. Register it in `src/fraud/rules/index.ts`.
4. Add unit tests in `tests/unit/fraud-rules.test.ts`, and a MockAdapter scenario +
   `scenarioExpectations` entry if it catches a new pattern, so `fraud:simulate` covers it.
5. If it needs new data, extend `FraudContext` and `buildFraudContext`.

## Designed for later (interfaces in `src/fraud/later.ts`)

Perceptual hashing of thumbnails/frames (re-uploads across accounts), audience geography
mismatch, a comment-quality classifier for bot comments, clipper trust tiers (longer holds for new
clippers), and an ML scorer trained on `ReviewDecision` labels.
