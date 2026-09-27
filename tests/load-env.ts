import { existsSync } from "node:fs";
import path from "node:path";

/** Load .env for local runs (CI passes variables explicitly). Never overrides existing vars. */
export function loadDotEnv() {
  const file = path.resolve(__dirname, "..", ".env");
  if (existsSync(file)) {
    const before = { ...process.env };
    process.loadEnvFile(file);
    Object.assign(process.env, before);
  }
}

export function testDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/\/(\w+)(\?|$)/, "/$1_test$2") : undefined);
  if (!url) throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL) to run tests");
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.includes("test"))
    throw new Error(`Refusing to run tests against non-test database "${dbName}"`);
  return url;
}
