/**
 * npm run worker — the single background worker process (pg-boss on the same Postgres).
 */
import PgBoss from "pg-boss";
import { env } from "@/env";
import { db } from "@/lib/db";
import { jobs } from "@/jobs/queues";

async function main() {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss" });
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();

  for (const job of jobs) {
    await boss.createQueue(job.name, {
      name: job.name,
      policy: "stately",
      retryLimit: 3,
      retryDelay: 30,
      expireInSeconds: 15 * 60,
    });
    await boss.schedule(job.name, job.cron, {}, { tz: "Asia/Kolkata" });
    await boss.work(job.name, { pollingIntervalSeconds: 5 }, async () => {
      const started = Date.now();
      const result = await job.run();
      console.log(`[worker] ${job.name} done in ${Date.now() - started}ms`, JSON.stringify(result));
    });
    console.log(`[worker] ${job.name} scheduled (${job.cron}) — ${job.description}`);
  }
  // Run the time-critical sweeps once on boot instead of waiting for the first cron tick.
  for (const name of ["metrics-poll", "lifecycle-lock", "lifecycle-hold-end"]) await boss.send(name, {});

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    await boss.stop({ graceful: true, timeout: 20_000 });
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("[worker] running. Ctrl+C to stop.");
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
