/**
 * Cold start benchmark for Prisma.
 * Skipped if @prisma/client is not installed.
 */

const t0 = process.hrtime.bigint();

let PrismaClient;
try {
  const mod = await import("@prisma/client");
  PrismaClient = mod.PrismaClient;
} catch {
  console.log(JSON.stringify({ orm: "prisma", skipped: true, reason: "@prisma/client not installed" }));
  process.exit(0);
}

const tImport = process.hrtime.bigint();

let client;
try {
  client = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL || "postgresql://localhost:55432/benchmark" } },
  });
} catch {
  console.log(JSON.stringify({ orm: "prisma", skipped: true, reason: "Failed to create PrismaClient" }));
  process.exit(0);
}

const tDataSource = process.hrtime.bigint();

try {
  await client.$queryRaw`SELECT 1`;
} catch {
  console.log(JSON.stringify({ orm: "prisma", skipped: true, reason: "No database connection" }));
  process.exit(0);
}

const tQuery = process.hrtime.bigint();
await client.$disconnect();

const toMs = (start, end) => Number(end - start) / 1e6;

console.log(JSON.stringify({
  orm: "prisma",
  importMs: toMs(t0, tImport),
  dataSourceMs: toMs(tImport, tDataSource),
  firstQueryMs: toMs(tDataSource, tQuery),
  totalMs: toMs(t0, tQuery),
}));
