import { MysqlDataSource } from "../../mysql-data-source.js";

const DEFAULT_CONNECTION = {
  host: process.env.MYSQL_HOST ?? "localhost",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "espalier_test",
};

export function createTestDataSource(): MysqlDataSource {
  return new MysqlDataSource({
    mysql: DEFAULT_CONNECTION,
  });
}

export async function isMysqlAvailable(): Promise<boolean> {
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
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      age INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

export function dropTestTable(tableName: string): string {
  return `DROP TABLE IF EXISTS ${tableName}`;
}
