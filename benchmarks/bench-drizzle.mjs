/**
 * Cold start benchmark for Drizzle ORM.
 * Skipped if drizzle-orm is not installed.
 */

const t0 = process.hrtime.bigint();

let drizzle, pgTable, serial, text;
try {
  const dMod = await import("drizzle-orm/pg-core");
  pgTable = dMod.pgTable;
  serial = dMod.serial;
  text = dMod.text;
  const dConn = await import("drizzle-orm/node-postgres");
  drizzle = dConn.drizzle;
} catch {
  console.log(JSON.stringify({ orm: "drizzle", skipped: true, reason: "drizzle-orm not installed" }));
  process.exit(0);
}

const tImport = process.hrtime.bigint();

let db;
try {
  const pg = await import("pg");
  const pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://nesify@localhost:55432/nesify",
  });
  db = drizzle(pool);
} catch {
  console.log(JSON.stringify({ orm: "drizzle", skipped: true, reason: "Failed to create connection" }));
  process.exit(0);
}

const tDataSource = process.hrtime.bigint();

try {
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`SELECT 1`);
} catch {
  console.log(JSON.stringify({ orm: "drizzle", skipped: true, reason: "No database connection" }));
  process.exit(0);
}

const tQuery = process.hrtime.bigint();

const toMs = (start, end) => Number(end - start) / 1e6;

console.log(JSON.stringify({
  orm: "drizzle",
  importMs: toMs(t0, tImport),
  dataSourceMs: toMs(tImport, tDataSource),
  firstQueryMs: toMs(tDataSource, tQuery),
  totalMs: toMs(t0, tQuery),
}));
