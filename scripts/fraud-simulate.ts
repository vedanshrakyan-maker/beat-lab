/**
 * npm run fraud:simulate
 * Runs every MockAdapter scenario through the full lifecycle and the fraud engine.
 * Acceptance: every clean scenario auto-approves; every fraud scenario is flagged,
 * voided or rejected. Exits non-zero otherwise (CI gate).
 */
import { simulateAll, type SimulationResult } from "@/fraud/simulate";

const SEEDS = Number(process.env.SIM_SEEDS ?? 10);

function pad(value: string | number, width: number) {
  return String(value).padEnd(width);
}

async function main() {
  const results = await simulateAll(SEEDS);
  const byScenario = new Map<string, SimulationResult[]>();
  for (const r of results) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);

  console.log(`\nFraud simulation — ${SEEDS} seeded posts per scenario\n`);
  console.log(
    `${pad("SCENARIO", 22)}${pad("EXPECTED", 16)}${pad("DECISIONS", 34)}${pad("SCORE", 10)}${pad("PASS", 7)}SIGNALS (example)`,
  );
  console.log("-".repeat(140));
  let failures = 0;
  for (const [scenario, rows] of byScenario) {
    const decisions = new Map<string, number>();
    rows.forEach((r) => decisions.set(r.finalDecision, (decisions.get(r.finalDecision) ?? 0) + 1));
    const passed = rows.filter((r) => r.passed).length;
    failures += rows.length - passed;
    const scores = rows.map((r) => r.maxScore);
    const decisionText = [...decisions].map(([d, n]) => `${d}×${n}`).join(" ");
    console.log(
      `${pad(scenario, 22)}${pad(rows[0]!.expected, 16)}${pad(decisionText, 34)}` +
        `${pad(`${Math.min(...scores)}–${Math.max(...scores)}`, 10)}${pad(`${passed}/${rows.length}`, 7)}` +
        `${rows[0]!.topSignals.join(", ") || "—"}`,
    );
  }
  console.log("-".repeat(140));
  if (failures > 0) {
    console.error(`\n✗ ${failures} simulated submission(s) did not match the expected outcome.\n`);
    for (const r of results.filter((x) => !x.passed)) {
      console.error(
        `  ${r.scenario} ${r.postId}: got ${r.finalDecision} (score ${r.maxScore}) — ${r.topSignals.join(", ")}`,
      );
    }
    process.exit(1);
  }
  console.log("\n✓ All clean scenarios auto-approved; all fraud scenarios flagged, voided or rejected.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
