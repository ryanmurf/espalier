import type { ColumnInfo, Connection, SchemaIntrospector, TableInfo } from "espalier-jdbc";

const DEFAULT_SCHEMA = "public";

export class PgSchemaIntrospector implements SchemaIntrospector {
  constructor(private readonly connection: Connection) {}

  async getTables(schema?: string): Promise<TableInfo[]> {
    const schemaName = schema ?? DEFAULT_SCHEMA;
    const ps = this.connection.prepareStatement(
      `SELECT table_name, table_schema
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    ps.setParameter(1, schemaName);
    try {
      const rs = await ps.executeQuery();
      try {
        const tables: TableInfo[] = [];
        while (await rs.next()) {
          tables.push({
            tableName: rs.getString("table_name")!,
            schema: rs.getString("table_schema")!,
          });
        }
        return tables;
      } finally {
        await rs.close();
      }
    } finally {
      await ps.close();
    }
  }

  async getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]> {
    const schemaName = schema ?? DEFAULT_SCHEMA;

    // Get primary key columns
    const pkColumns = new Set(await this.getPrimaryKeys(tableName, schemaName));

    // Get unique columns
    const uniqueColumns = await this.getUniqueColumns(tableName, schemaName);

    const ps = this.connection.prepareStatement(
      `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = $2
       ORDER BY ordinal_position`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, schemaName);
    try {
      const rs = await ps.executeQuery();
      try {
        const columns: ColumnInfo[] = [];
        while (await rs.next()) {
          const columnName = rs.getString("column_name")!;
          columns.push({
            columnName,
            dataType: rs.getString("data_type")!,
            nullable: rs.getString("is_nullable") === "YES",
            defaultValue: rs.getString("column_default"),
            primaryKey: pkColumns.has(columnName),
            unique: uniqueColumns.has(columnName),
            maxLength: rs.getNumber("character_maximum_length"),
          });
        }
        return columns;
      } finally {
        await rs.close();
      }
    } finally {
      await ps.close();
    }
  }

  async getPrimaryKeys(tableName: string, schema?: string): Promise<string[]> {
    const schemaName = schema ?? DEFAULT_SCHEMA;
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
    ps.setParameter(2, schemaName);
    try {
      const rs = await ps.executeQuery();
      try {
        const keys: string[] = [];
        while (await rs.next()) {
          keys.push(rs.getString("column_name")!);
        }
        return keys;
      } finally {
        await rs.close();
      }
    } finally {
      await ps.close();
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const schemaName = schema ?? DEFAULT_SCHEMA;
    const ps = this.connection.prepareStatement(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = $1 AND table_schema = $2 AND table_type = 'BASE TABLE'`,
    );
    ps.setParameter(1, tableName);
    ps.setParameter(2, schemaName);
    try {
      const rs = await ps.executeQuery();
      try {
        return rs.next();
      } finally {
        await rs.close();
      }
    } finally {
      await ps.close();
    }
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
    try {
      const rs = await ps.executeQuery();
      try {
        const columns = new Set<string>();
        while (await rs.next()) {
          columns.add(rs.getString("column_name")!);
        }
        return columns;
      } finally {
        await rs.close();
      }
    } finally {
      await ps.close();
    }
  }
}
