import { PgDataSource } from "../../pg-data-source.js";

const DEFAULT_CONNECTION = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

export function createTestDataSource(): PgDataSource {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new PgDataSource({ connectionString });
  }
  return new PgDataSource(DEFAULT_CONNECTION);
}

export async function isPostgresAvailable(): Promise<boolean> {
  const ds = createTestDataSource();
  try {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");
    await conn.close();
    await ds.close();
    return true;
  } catch {
    try {
      await ds.close();
    } catch {
      // ignore
    }
    return false;
  }
}

export function testTableDDL(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      age INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export function dropTestTable(tableName: string): string {
  return `DROP TABLE IF EXISTS ${tableName} CASCADE`;
}
