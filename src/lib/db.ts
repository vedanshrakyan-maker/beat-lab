import { PrismaClient } from "@prisma/client";

// One PrismaClient per process (Next.js dev hot-reload would otherwise leak connections).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/** The transaction client type passed to `db.$transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
export type DbOrTx = PrismaClient | Tx;
