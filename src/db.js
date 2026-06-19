import { PrismaClient } from "@prisma/client";

// Singleton pattern — prevents multiple Prisma instances during hot reloads
const globalForPrisma = globalThis;

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
