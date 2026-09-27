/**
 * npm run db:seed — builds a realistic demo world THROUGH THE REAL DOMAIN CODE:
 * campaigns are funded via signed mock webhooks, posts are submitted with a virtual clock in
 * the past, and the lifecycle (snapshots, accrual, fraud, lock, hold, payable) is replayed by
 * the same functions the worker runs. The ledger is therefore consistent by construction,
 * and `npm run ledger:verify` must pass afterwards.
 *
 * Safe-guarded: refuses to run with APP_ENV=production. It EMPTIES the target database.
 */
import type { Prisma } from "@prisma/client";
import { env } from "@/env";
import { systemActor, userActor } from "@/lib/audit";
import { fingerprintHash } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatINR, rupees } from "@/lib/money";
import { settingRegistry } from "@/lib/settings";
import { recordLedgerVerification } from "@/ledger/verify";
import { createCampaign, endExpiredCampaigns, settleCampaigns, type CampaignInput } from "@/domain/campaigns";
import { catchUpSubmission } from "@/domain/devtools";
import { handlePaymentWebhook, startFunding } from "@/domain/funding";
import {
  approvePayoutBatch,
  createPayoutBatch,
  requestWithdrawal,
  savePayoutProfile,
  syncProcessingPayouts,
  walletSummary,
} from "@/domain/payouts";
import { adminVoidSubmission, approveSubmission } from "@/domain/review";
import { connectMockAccount } from "@/domain/social-accounts";
import { SubmissionError, submitPost } from "@/domain/submissions";
import { MockPaymentProvider, MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/payments/mock";
import type { MockScenario } from "@/platforms/mock";

const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (d: number, hourOffset = 0) => new Date(NOW.getTime() - d * DAY + hourOffset * 3_600_000);

// Deterministic PRNG so every seed run builds the same world.
let seed = 20260927;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const between = (a: number, b: number) => Math.floor(a + rand() * (b - a));
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const code = (n: number) =>
  Array.from({ length: n }, () => ALPHA[Math.floor(rand() * ALPHA.length)]).join("");

async function truncateAll() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

const provider = () => new MockPaymentProvider(env().MOCK_WEBHOOK_SECRET, env().APP_URL);

async function fund(campaignId: string, userId: string) {
  const order = await startFunding(campaignId, userActor(userId), provider());
  const payment = await db.fundingPayment.findUniqueOrThrow({
    where: { providerOrderId: order.providerOrderId },
  });
  const body = JSON.stringify({
    type: "funding.paid",
    eventId: `evt_seed_${campaignId}`,
    providerOrderId: order.providerOrderId,
    providerPaymentId: `pay_seed_${campaignId.slice(-8)}`,
    amountPaise: payment.amountPaise.toString(),
  });
  const outcome = await handlePaymentWebhook(provider(), {
    rawBody: body,
    headers: new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, env().MOCK_WEBHOOK_SECRET) }),
  });
  if (outcome !== "processed") throw new Error(`Funding webhook for ${campaignId}: ${outcome}`);
}

const FIRST = [
  "Aarav",
  "Ananya",
  "Vihaan",
  "Diya",
  "Arjun",
  "Ishita",
  "Kabir",
  "Meera",
  "Reyansh",
  "Saanvi",
  "Aditya",
  "Kavya",
  "Rohit",
  "Sneha",
  "Farhan",
  "Zoya",
  "Karthik",
  "Lakshmi",
  "Harpreet",
  "Neha",
  "Siddharth",
  "Pooja",
  "Aman",
  "Tanvi",
  "Yash",
];
const LAST = [
  "Sharma",
  "Iyer",
  "Khan",
  "Reddy",
  "Patel",
  "Das",
  "Nair",
  "Singh",
  "Gupta",
  "Menon",
  "Joshi",
  "Kulkarni",
  "Banerjee",
  "Chopra",
  "Rao",
];
const BANKS = ["okicici", "okaxis", "oksbi", "ybl", "paytm", "okhdfcbank"];

async function main() {
  const e = env();
  if (e.APP_ENV === "production") throw new Error("Refusing to seed a production environment");
  console.log("Seeding ReelPay demo world…");
  await truncateAll();

  // --- settings & tax --------------------------------------------------------
  for (const [key, entry] of Object.entries(settingRegistry)) {
    await db.setting.create({ data: { key, value: entry.defaults as Prisma.InputJsonValue } });
  }
  await db.taxRule.create({
    data: {
      name: "Professional/contract fees — CONFIRM WITH CA",
      appliesTo: "CLIPPER_PAYOUT",
      ratePctBps: 1000, // PLACEHOLDER
      rateWithoutPanBps: 2000, // PLACEHOLDER
      annualThresholdPaise: rupees(30_000), // PLACEHOLDER
      perTransactionThresholdPaise: null,
      sectionLabel:
        "PLACEHOLDER: professional/contract fees — CONFIRM WITH CA (Income-tax Act, 2025 renumbered TDS sections)",
      notes: "All values are placeholders. Classification of creator payments depends on contract structure.",
      effectiveFrom: new Date("2026-04-01T00:00:00+05:30"),
    },
  });

  // --- users ------------------------------------------------------------------
  const admin = await db.user.create({
    data: { email: "admin@reelpay.local", name: "Priya Admin", roles: ["ADMIN"], emailVerified: NOW },
  });
  const funders = [
    { email: "rohan@creator.local", name: "Rohan Joshi", org: "Rohan Joshi Comedy", gstin: null },
    {
      email: "host@desifounders.local",
      name: "Meenal Rao",
      org: "The Desi Founders Podcast",
      gstin: "27AABCD1234E1Z5",
    },
    {
      email: "growth@kesarichai.local",
      name: "Vikram Kesari",
      org: "Kesari Chai Co.",
      gstin: "29AAFCK5678L1Z2",
    },
  ];
  const orgs: Record<string, { userId: string; orgId: string }> = {};
  for (const f of funders) {
    // The creator also clips (a user may hold several roles).
    const roles = f.email.startsWith("rohan") ? (["FUNDER", "CLIPPER"] as const) : (["FUNDER"] as const);
    const user = await db.user.create({
      data: { email: f.email, name: f.name, roles: [...roles], emailVerified: NOW },
    });
    const org = await db.organization.create({
      data: {
        name: f.org,
        gstin: f.gstin,
        billingEmail: f.email,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    orgs[f.org] = { userId: user.id, orgId: org.id };
  }

  type Clipper = { id: string; name: string; ig?: string; yt?: string; followers: number };
  const clippers: Clipper[] = [];
  for (let i = 0; i < 25; i++) {
    const name = `${FIRST[i]} ${LAST[i % LAST.length]}`;
    const handle = `${FIRST[i]!.toLowerCase()}${pick(["clips", "edits", "reels", "shorts", "cuts", "fanpage"])}`;
    const small = i % 7 === 3; // a few tiny/new accounts
    const followers = small ? between(250, 900) : between(3_000, 180_000);
    const user = await db.user.create({
      data: {
        email: `${FIRST[i]!.toLowerCase()}@clipper.local`,
        name,
        roles: ["CLIPPER"],
        emailVerified: NOW,
        createdAt: daysAgo(between(40, 200)),
      },
    });
    const c: Clipper = { id: user.id, name, followers };
    const accountCreatedAt = small ? daysAgo(between(75, 110)) : daysAgo(between(300, 2000));
    if (i % 3 !== 2)
      c.ig = (
        await connectMockAccount(user.id, "INSTAGRAM", handle, userActor(user.id), {
          followerCount: followers,
          accountCreatedAt,
        })
      ).id;
    if (i % 3 !== 0)
      c.yt = (
        await connectMockAccount(user.id, "YOUTUBE", `${handle}yt`, userActor(user.id), {
          followerCount: Math.round(followers * 0.6),
          accountCreatedAt,
        })
      ).id;
    clippers.push(c);

    // Payout profiles for most clippers. Clippers 23 and 24 share a UPI ID and a device
    // (MULTI_ACCOUNT fraud). Clipper 5 has a "fail" UPI to demo failed payouts.
    if (i !== 20) {
      const upi =
        i === 24
          ? "yash.sharma@ybl"
          : i === 23
            ? "yash.sharma@ybl"
            : i === 5
              ? `fail.${FIRST[i]!.toLowerCase()}@ybl`
              : `${FIRST[i]!.toLowerCase()}.${LAST[i % LAST.length]!.toLowerCase()}@${pick(BANKS)}`;
      const pan =
        i % 4 === 1
          ? undefined
          : `${code(5)
              .toUpperCase()
              .replace(/[^A-Z]/g, "Q")
              .padEnd(5, "Q")
              .slice(0, 5)}${between(1000, 9999)}${pick(["A", "K", "P", "Z"])}`;
      await savePayoutProfile(user.id, { legalName: name, upiId: upi, pan }, userActor(user.id));
    }
    const ip = i >= 23 ? "49.36.10.23" : `103.${between(10, 250)}.${between(0, 255)}.${between(1, 254)}`;
    const ua =
      i >= 23
        ? "Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome/129"
        : `Mozilla/5.0 (Linux; Android ${between(11, 15)}) Chrome/${between(118, 130)} #${i}`;
    await db.deviceFingerprint.create({
      data: { userId: user.id, ipHash: fingerprintHash(ip), userAgentHash: fingerprintHash(ua) },
    });
  }
  // Rohan (creator/funder) also clips on Instagram.
  const rohan = orgs["Rohan Joshi Comedy"]!.userId;
  await connectMockAccount(rohan, "INSTAGRAM", "rohanjoshi.official", userActor(rohan), {
    followerCount: 412_000,
    accountCreatedAt: daysAgo(2400),
  });

  // --- campaigns ----------------------------------------------------------------
  const base = (orgName: string, over: Partial<CampaignInput>): CampaignInput => ({
    organizationId: orgs[orgName]!.orgId,
    title: "Untitled",
    description: "Clip it.",
    type: "CLIPPING",
    sourceContentUrls: [],
    rules: { requiredHashtags: [], requiredMentions: [] },
    allowedPlatforms: ["INSTAGRAM", "YOUTUBE"],
    ratePer1kViewsPaise: 3000n,
    budgetPaise: rupees(100_000),
    platformFeeBps: 1000,
    gstOnFeeBps: 1800,
    maxPayoutPerSubmissionPaise: null,
    maxPayoutPerClipperPaise: null,
    minViewsToQualify: 1000,
    trackingWindowDays: 7,
    holdPeriodDays: 7,
    ...over,
  });

  const specs = [
    {
      key: "podcast",
      org: "The Desi Founders Podcast",
      input: base("The Desi Founders Podcast", {
        title: "Desi Founders: the best startup moments",
        category: "Podcast",
        description:
          "Cut 30–60 second clips from our founder interviews — the funniest, most honest and most useful moments. Hook in the first 2 seconds, burned-in Hindi or English captions, and tag us.",
        sourceContentUrls: [
          "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
          "https://www.youtube.com/watch?v=ScMzIvxBSi4",
        ],
        rules: {
          requiredHashtags: ["#desifounders"],
          requiredMentions: ["@desifounders"],
          maxDurationSec: 90,
          languages: ["Hindi", "English"],
          disallowedContent: ["Misquoting guests", "Political commentary"],
        },
        ratePer1kViewsPaise: 3000n,
        budgetPaise: rupees(300_000),
        maxPayoutPerSubmissionPaise: rupees(5_000),
        maxPayoutPerClipperPaise: rupees(25_000),
        startsAt: daysAgo(30),
        endsAt: daysAgo(-30),
      }),
      subs: 70,
      window: [1, 24],
    },
    {
      key: "creator",
      org: "Rohan Joshi Comedy",
      input: base("Rohan Joshi Comedy", {
        title: "Rohan Joshi stand-up: clip the punchlines",
        category: "Comedy",
        description:
          "Clip the best bits from the new special. Keep the punchline intact, no reaction overlays.",
        sourceContentUrls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"],
        rules: { requiredHashtags: ["#rohanjoshi"], requiredMentions: [], maxDurationSec: 60 },
        ratePer1kViewsPaise: 4500n,
        budgetPaise: rupees(40_000),
        maxPayoutPerSubmissionPaise: rupees(2_500),
        startsAt: daysAgo(25),
        endsAt: daysAgo(-10),
      }),
      subs: 22,
      window: [2, 22],
    },
    {
      key: "brand",
      org: "Kesari Chai Co.",
      input: base("Kesari Chai Co.", {
        title: "Kesari Chai: your morning chai ritual (UGC)",
        category: "Food & drink",
        type: "UGC",
        description:
          "Film your real morning chai ritual with Kesari Chai. Natural light, real kitchens, no scripts.",
        rules: {
          requiredHashtags: ["#kesarichai", "#chaitime"],
          requiredMentions: ["@kesarichai"],
          allowFanPages: false,
          languages: ["Hindi", "Marathi", "Kannada", "English"],
        },
        ratePer1kViewsPaise: 2500n,
        budgetPaise: rupees(150_000),
        maxPayoutPerSubmissionPaise: rupees(4_000),
        startsAt: daysAgo(35),
        endsAt: daysAgo(4),
      }),
      subs: 36,
      window: [6, 34],
    },
    {
      key: "settled",
      org: "Kesari Chai Co.",
      input: base("Kesari Chai Co.", {
        title: "Kesari Chai Diwali gifting (UGC)",
        category: "Festive",
        type: "UGC",
        description: "Show how you gift Kesari Chai this Diwali.",
        rules: { requiredHashtags: ["#kesaridiwali"], requiredMentions: [] },
        ratePer1kViewsPaise: 1500n,
        budgetPaise: rupees(25_000),
        maxPayoutPerSubmissionPaise: rupees(1_500),
        startsAt: daysAgo(70),
        endsAt: daysAgo(40),
      }),
      subs: 14,
      window: [42, 68],
    },
  ] as const;

  const campaigns: Record<string, { id: string; tags: string[] }> = {};
  for (const s of specs) {
    const c = await createCampaign(s.input, orgs[s.org]!.userId, userActor(orgs[s.org]!.userId));
    await db.campaign.update({ where: { id: c.id }, data: { createdAt: s.input.startsAt ?? NOW } });
    await fund(c.id, orgs[s.org]!.userId);
    const r = s.input.rules;
    campaigns[s.key] = { id: c.id, tags: [...(r.requiredHashtags ?? []), ...(r.requiredMentions ?? [])] };
  }
  // Draft campaign (not funded).
  await createCampaign(
    base("Rohan Joshi Comedy", {
      title: "Roast battle highlights",
      category: "Comedy",
      description: "Clip the sharpest roast-battle exchanges. Draft — not funded yet.",
      sourceContentUrls: ["https://www.youtube.com/watch?v=9bZkp7q5SGc"],
      ratePer1kViewsPaise: 6000n,
      budgetPaise: rupees(80_000),
      maxPayoutPerSubmissionPaise: rupees(6_000),
    }),
    rohan,
    userActor(rohan),
  );
  // A managed campaign an admin set up for the podcast, awaiting funding.
  await createCampaign(
    base("The Desi Founders Podcast", {
      title: "Desi Founders: live-show recap (managed)",
      category: "Podcast",
      description: "Managed by the ReelPay team: recap clips from the Bengaluru live show.",
      sourceContentUrls: ["https://www.youtube.com/watch?v=aqz-KE-bpKQ"],
      budgetPaise: rupees(75_000),
      maxPayoutPerSubmissionPaise: rupees(3_000),
      isManaged: true,
    }),
    admin.id,
    userActor(admin.id),
  );

  // --- submissions -----------------------------------------------------------------
  // Every fraud scenario appears at least twice across campaigns.
  const fraudCycle: MockScenario[] = [
    "BOTTED_SPIKE",
    "DELETED_AFTER_LOCK",
    "PLATEAU_AT_CAP",
    "LOW_ENGAGEMENT",
    "LOOPING",
    "VIEW_DROP",
    "MISSING_HASHTAG",
    "INSIGHTS_UNAVAILABLE",
  ];
  let fraudIdx = 0;
  const submissionIds: { id: string; at: Date; campaign: string; clipper: Clipper }[] = [];
  let duplicates = 0;

  for (const s of specs) {
    const c = campaigns[s.key]!;
    const participants = new Set<string>();
    for (let i = 0; i < s.subs; i++) {
      const isFraud = i % 6 === 5 || (s.key === "podcast" && i % 11 === 7);
      // Clippers 23/24 are the linked multi-account pair; they only appear as MULTI_ACCOUNT.
      let clipper = pick(clippers.slice(0, 23));
      let scenario: MockScenario;
      if (isFraud) {
        scenario = fraudCycle[fraudIdx++ % fraudCycle.length]!;
        if (scenario === "BOTTED_SPIKE")
          clipper = clippers.find((x) => x.followers < 1000 && x.ig) ?? clipper;
      } else {
        const r = rand();
        const viralShare = s.key === "creator" ? 0.45 : 0.14;
        scenario =
          r < viralShare
            ? "CLEAN_VIRAL"
            : r < viralShare + 0.06 && clipper.followers < 1000
              ? "SMALL_ACCOUNT_VIRAL"
              : "CLEAN_SLOW";
      }
      if (s.key === "podcast" && i % 17 === 4) {
        clipper = clippers[23 + (i % 2)]!; // the linked multi-account pair
        scenario = "MULTI_ACCOUNT";
      }
      const allowed = s.input.allowedPlatforms;
      let platform: "INSTAGRAM" | "YOUTUBE" =
        clipper.ig && (rand() < 0.6 || !clipper.yt) ? "INSTAGRAM" : "YOUTUBE";
      if (scenario === "INSIGHTS_UNAVAILABLE" || scenario === "LOOPING") platform = "INSTAGRAM";
      if (platform === "INSTAGRAM" && !clipper.ig)
        clipper = clippers.find((x) => x.ig && x.id !== clipper.id)!;
      if (platform === "YOUTUBE" && !clipper.yt) clipper = clippers.find((x) => x.yt)!;
      if (!allowed.includes(platform)) continue;
      const accountId = platform === "INSTAGRAM" ? clipper.ig! : clipper.yt!;

      if (!participants.has(clipper.id)) {
        await db.campaignParticipation.upsert({
          where: { campaignId_clipperId: { campaignId: c.id, clipperId: clipper.id } },
          create: { campaignId: c.id, clipperId: clipper.id, joinedAt: daysAgo(s.window[1] + 1) },
          update: {},
        });
        participants.add(clipper.id);
      }
      const at = daysAgo(between(s.window[0], s.window[1]), between(0, 23));
      const url =
        platform === "INSTAGRAM"
          ? `https://www.instagram.com/reel/C${code(10)}/?mock=${scenario.toLowerCase()}`
          : `https://www.youtube.com/shorts/${code(11)}?mock=${scenario.toLowerCase()}`;
      try {
        const res = await submitPost(
          clipper.id,
          { campaignId: c.id, socialAccountId: accountId, postUrl: url },
          userActor(clipper.id),
          { now: at },
        );
        submissionIds.push({ id: res.submission.id, at, campaign: s.key, clipper });
      } catch (err) {
        if (!(err instanceof SubmissionError)) throw err;
      }
    }
  }
  // Someone tries to re-submit another clipper's post.
  const victim = submissionIds[3]!;
  const victimSub = await db.submission.findUniqueOrThrow({ where: { id: victim.id } });
  const thief = clippers.find(
    (x) => x.id !== victim.clipper.id && (victimSub.platform === "INSTAGRAM" ? x.ig : x.yt),
  )!;
  await db.campaignParticipation.upsert({
    where: { campaignId_clipperId: { campaignId: victimSub.campaignId, clipperId: thief.id } },
    create: { campaignId: victimSub.campaignId, clipperId: thief.id },
    update: {},
  });
  for (let k = 0; k < 2; k++) {
    try {
      await submitPost(
        thief.id,
        {
          campaignId: victimSub.campaignId,
          socialAccountId: (victimSub.platform === "INSTAGRAM" ? thief.ig : thief.yt)!,
          postUrl: victimSub.postUrl,
        },
        userActor(thief.id),
        { now: daysAgo(1) },
      );
    } catch {
      duplicates++;
    }
  }

  console.log(`  ${submissionIds.length} submissions created; replaying lifecycles…`);
  submissionIds.sort((a, b) => a.at.getTime() - b.at.getTime()); // first come, first served
  let n = 0;
  for (const s of submissionIds) {
    await catchUpSubmission(s.id, NOW);
    if (++n % 25 === 0) console.log(`    ${n}/${submissionIds.length}`);
  }

  // --- admin decisions (training labels) --------------------------------------------
  const flagged = await db.submission.findMany({
    where: { status: "FLAGGED" },
    orderBy: { fraudScore: "desc" },
  });
  for (const f of flagged.slice(0, Math.ceil(flagged.length / 2))) {
    await adminVoidSubmission(
      f.id,
      admin.id,
      "Reviewed snapshots and signals: views are not organic.",
      userActor(admin.id),
    );
  }
  // One manual-metrics review completed: approve with admin-entered numbers.
  const manual = await db.submission.findFirst({
    where: { metricsSource: "UNAVAILABLE", status: "UNDER_REVIEW" },
    orderBy: { submittedAt: "asc" },
  });
  if (manual) {
    const { enterManualMetrics } = await import("@/domain/review");
    const t = new Date(manual.submittedAt.getTime() + 2 * DAY);
    if (t < NOW) {
      await enterManualMetrics(
        manual.id,
        admin.id,
        {
          views: 18_400,
          likes: 1_320,
          comments: 64,
          shares: 210,
          reach: 12_900,
          capturedAt: t,
          note: "From screen recording",
        },
        userActor(admin.id),
        t,
      );
      await approveSubmission(
        manual.id,
        admin.id,
        "Screen recording matches: 18.4K views, healthy engagement.",
        userActor(admin.id),
        t,
      );
      await catchUpSubmission(manual.id, NOW);
    }
  }

  // The old Diwali campaign was fully reviewed before settling.
  const leftovers = await db.submission.findMany({
    where: {
      campaignId: campaigns.settled!.id,
      OR: [{ status: { in: ["UNDER_REVIEW", "FLAGGED"] } }, { reviewState: "NEEDS_REVIEW", status: "HELD" }],
    },
  });
  for (const l of leftovers) {
    if (l.status === "HELD")
      await approveSubmission(
        l.id,
        admin.id,
        "Small account but organic engagement and steady growth: genuine viral clip.",
        userActor(admin.id),
      );
    else if (l.status === "UNDER_REVIEW")
      await (
        await import("@/domain/review")
      ).rejectSubmission(
        l.id,
        admin.id,
        "Linked to another clipper's payout details; not eligible.",
        userActor(admin.id),
      );
    else
      await adminVoidSubmission(
        l.id,
        admin.id,
        "Views pinned at the payout cap: bought views.",
        userActor(admin.id),
      );
  }

  // --- campaign end / settlement ------------------------------------------------------
  await endExpiredCampaigns(NOW);
  await settleCampaigns();

  // --- payouts ------------------------------------------------------------------------
  const eligible: string[] = [];
  for (const c of clippers) {
    const w = await walletSummary(c.id);
    if (w.payablePaise >= w.minWithdrawalPaise && (await db.payoutProfile.count({ where: { userId: c.id } })))
      eligible.push(c.id);
  }
  // Older batch: paid (one fails because of the "fail" UPI).
  const firstWave = eligible.slice(0, Math.ceil(eligible.length * 0.55));
  for (const uid of firstWave) await requestWithdrawal(uid, `seed-${uid}-1`, userActor(uid), daysAgo(6));
  if (firstWave.length) {
    const b1 = await createPayoutBatch(admin.id, userActor(admin.id));
    await approvePayoutBatch(b1.id, admin.id, userActor(admin.id), provider());
    await syncProcessingPayouts(provider());
  }
  // Clawback: fraud discovered after payment on one paid submission.
  const paid = await db.submission.findFirst({ where: { status: "PAID" }, orderBy: { earnedPaise: "asc" } });
  if (paid) {
    await adminVoidSubmission(
      paid.id,
      admin.id,
      "Clip found re-uploaded from another creator's channel after payout.",
      userActor(admin.id),
    );
  }
  // Newer batch: awaiting approval, plus some unbatched requests.
  const secondWave = eligible.slice(firstWave.length);
  const batched = secondWave.slice(0, Math.ceil(secondWave.length / 2));
  for (const uid of batched) await requestWithdrawal(uid, `seed-${uid}-2`, userActor(uid), daysAgo(1));
  if (batched.length) await createPayoutBatch(admin.id, userActor(admin.id));
  for (const uid of secondWave.slice(batched.length)) {
    try {
      await requestWithdrawal(uid, `seed-${uid}-3`, userActor(uid), NOW);
    } catch {
      /* flagged or below minimum */
    }
  }

  // Seeded notifications are historical: don't email them all when the worker starts.
  await db.notification.updateMany({ data: { emailedAt: NOW } });
  await db.notification.updateMany({ where: { createdAt: { lt: daysAgo(3) } }, data: { readAt: NOW } });
  void systemActor;

  // --- summary ----------------------------------------------------------------------
  const byStatus = await db.submission.groupBy({ by: ["status"], _count: true });
  const campaignsByStatus = await db.campaign.groupBy({ by: ["status"], _count: true });
  const verification = await recordLedgerVerification();
  console.log("\nSubmissions by status:", Object.fromEntries(byStatus.map((r) => [r.status, r._count])));
  console.log("Campaigns by status:", Object.fromEntries(campaignsByStatus.map((r) => [r.status, r._count])));
  console.log(`Duplicate attempts blocked: ${duplicates}`);
  console.log(
    `Payouts: ${await db.payout.count()} (${formatINR((await db.payout.aggregate({ where: { status: "PAID" }, _sum: { netPaise: true } }))._sum.netPaise ?? 0n)} paid)`,
  );
  console.log(`Ledger verification: ${verification.ok ? "OK" : "FAILED"}`);
  for (const c of verification.checks.filter((x) => !x.ok))
    console.log(`  ✗ ${c.name}: ${c.details.slice(0, 3).join("; ")}`);
  console.log(
    "\nSign in at /signin with the dev switcher: admin@reelpay.local, host@desifounders.local, aarav@clipper.local …\n",
  );
  if (!verification.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
