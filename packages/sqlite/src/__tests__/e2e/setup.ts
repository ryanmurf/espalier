import { SqliteDataSource } from "../../sqlite-data-source.js";

export function createTestDataSource(): SqliteDataSource {
  return new SqliteDataSource({ filename: ":memory:" });
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
