import { PrismaClient } from "@prisma/client";

/** Empty every application table (test database only — guarded by testDatabaseUrl()). */
export async function truncateAll(url: string) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const tables = await client.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      await client.$executeRawUnsafe(
        `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`,
      );
    }
  } finally {
    await client.$disconnect();
  }
}
