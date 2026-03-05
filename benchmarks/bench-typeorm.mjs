/**
 * Cold start benchmark for TypeORM.
 * Skipped if typeorm is not installed.
 */

const t0 = process.hrtime.bigint();

let DataSource;
try {
  const mod = await import("typeorm");
  DataSource = mod.DataSource;
} catch {
  console.log(JSON.stringify({ orm: "typeorm", skipped: true, reason: "typeorm not installed" }));
  process.exit(0);
}

const tImport = process.hrtime.bigint();

let ds;
try {
  ds = new DataSource({
    type: "postgres",
    host: "localhost",
    port: 55432,
    username: "nesify",
    database: "nesify",
    synchronize: false,
  });
  await ds.initialize();
} catch {
  console.log(JSON.stringify({ orm: "typeorm", skipped: true, reason: "Failed to connect" }));
  process.exit(0);
}

const tDataSource = process.hrtime.bigint();

try {
  await ds.query("SELECT 1");
} catch {
  console.log(JSON.stringify({ orm: "typeorm", skipped: true, reason: "Query failed" }));
  process.exit(0);
}

const tQuery = process.hrtime.bigint();
await ds.destroy();

const toMs = (start, end) => Number(end - start) / 1e6;

console.log(JSON.stringify({
  orm: "typeorm",
  importMs: toMs(t0, tImport),
  dataSourceMs: toMs(tImport, tDataSource),
  firstQueryMs: toMs(tDataSource, tQuery),
  totalMs: toMs(t0, tQuery),
}));
