export let isSqliteAvailable = true;
let SqliteDataSourceClass: any;

try {
  const mod = await import("../../sqlite-data-source.js");
  SqliteDataSourceClass = mod.SqliteDataSource;
  const ds = new SqliteDataSourceClass({ filename: ":memory:" });
  ds.close();
} catch {
  isSqliteAvailable = false;
}

export function createTestDataSource() {
  if (!SqliteDataSourceClass) {
    throw new Error("SQLite native module not available");
  }
  return new SqliteDataSourceClass({ filename: ":memory:" });
}

export function testTableDDL(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      age INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `;
}

export function dropTestTable(tableName: string): string {
  return `DROP TABLE IF EXISTS ${tableName}`;
}
