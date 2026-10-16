import { PrismaClient } from "@prisma/client";

// Single Prisma client across hot reloads in dev. All data access goes through
// this module, so swapping the underlying database is a schema+env change only.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
