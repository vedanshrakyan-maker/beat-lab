import { execSync } from "node:child_process";
import { loadDotEnv, testDatabaseUrl } from "./load-env";
import { truncateAll } from "./truncate";

/** Bring the test database schema up to date (non-destructive) and empty it once per run. */
export default async function setup() {
  loadDotEnv();
  const url = testDatabaseUrl();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  await truncateAll(url);
}
