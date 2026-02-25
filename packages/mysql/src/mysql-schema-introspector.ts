import type { Connection, SchemaIntrospector, TableInfo, ColumnInfo } from "espalier-jdbc";

export class MysqlSchemaIntrospector implements SchemaIntrospector {
  constructor(private readonly connection: Connection) {}

  async getTables(schema?: string): Promise<TableInfo[]> {
    const dbName = schema ?? await this.currentDatabase();
    const ps = this.connection.prepareStatement(
      `SELECT table_name, table_schema
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    ps.setParameter(1, dbName);
    const rs = await ps.executeQuery();

    const tables: TableInfo[] = [];
    while (await rs.next()) {
      tables.push({
        tableName: rs.getString("table_name") ?? rs.getString("TABLE_NAME")!,
        schema: rs.getString("table_schema") ?? rs.getString("TABLE_SCHEMA")!,
      });
    }
    return tables;
  }

  async getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]> {
    const dbName = schema ?? await this.currentDatabase();

    // Get primary key columns
    const pkColumns = new Set(await this.getPrimaryKeys(tableName, dbName));

    // Get unique columns
    const uniqueColumns = await this.getUniqueColumns(tableName, dbName);

    const ps = this.connection.prepareStatement(
      `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = $2
       ORDER BY ordinal_position`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, dbName);
    const rs = await ps.executeQuery();

    const columns: ColumnInfo[] = [];
    while (await rs.next()) {
      const columnName = rs.getString("column_name") ?? rs.getString("COLUMN_NAME")!;
      columns.push({
        columnName,
        dataType: rs.getString("data_type") ?? rs.getString("DATA_TYPE")!,
        nullable: (rs.getString("is_nullable") ?? rs.getString("IS_NULLABLE")) === "YES",
        defaultValue: rs.getString("column_default") ?? rs.getString("COLUMN_DEFAULT"),
        primaryKey: pkColumns.has(columnName),
        unique: uniqueColumns.has(columnName),
        maxLength: rs.getNumber("character_maximum_length") ?? rs.getNumber("CHARACTER_MAXIMUM_LENGTH"),
      });
    }
    return columns;
  }

  async getPrimaryKeys(tableName: string, schema?: string): Promise<string[]> {
    const dbName = schema ?? await this.currentDatabase();
    const ps = this.connection.prepareStatement(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = $1
         AND tc.table_schema = $2
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, dbName);
    const rs = await ps.executeQuery();

    const keys: string[] = [];
    while (await rs.next()) {
      keys.push(rs.getString("column_name") ?? rs.getString("COLUMN_NAME")!);
    }
    return keys;
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const dbName = schema ?? await this.currentDatabase();
    const ps = this.connection.prepareStatement(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = $1 AND table_schema = $2 AND table_type = 'BASE TABLE'`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, dbName);
    const rs = await ps.executeQuery();
    return rs.next();
  }

  private async getUniqueColumns(tableName: string, schema: string): Promise<Set<string>> {
    const ps = this.connection.prepareStatement(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = $1
         AND tc.table_schema = $2
         AND tc.constraint_type = 'UNIQUE'`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, schema);
    const rs = await ps.executeQuery();

    const columns = new Set<string>();
    while (await rs.next()) {
      columns.add(rs.getString("column_name") ?? rs.getString("COLUMN_NAME")!);
    }
    return columns;
  }

  private async currentDatabase(): Promise<string> {
    const stmt = this.connection.createStatement();
    const rs = await stmt.executeQuery("SELECT DATABASE() AS db");
    if (await rs.next()) {
      return rs.getString("db")!;
    }
    throw new Error("Could not determine current MySQL database");
  }
}
