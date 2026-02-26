import type { Connection, SchemaIntrospector, TableInfo, ColumnInfo } from "espalier-jdbc";

/** Validate a table name to prevent SQL injection in PRAGMA calls. */
function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

export class SqliteSchemaIntrospector implements SchemaIntrospector {
  constructor(private readonly connection: Connection) {}

  async getTables(schema?: string): Promise<TableInfo[]> {
    const stmt = this.connection.createStatement();
    try {
      const rs = await stmt.executeQuery(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      try {
        const tables: TableInfo[] = [];
        while (await rs.next()) {
          tables.push({
            tableName: rs.getString("name")!,
            schema: schema ?? "main",
          });
        }
        return tables;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  async getColumns(tableName: string, schema?: string): Promise<ColumnInfo[]> {
    const safeName = validateIdentifier(tableName);

    // Get primary key and column info from table_info pragma
    const stmt = this.connection.createStatement();
    try {
      const rs = await stmt.executeQuery(`PRAGMA table_info(${safeName})`);

      // Get unique columns from index analysis
      const uniqueColumns = await this.getUniqueColumns(tableName);

      try {
        const columns: ColumnInfo[] = [];
        while (await rs.next()) {
          const columnName = rs.getString("name")!;
          columns.push({
            columnName,
            dataType: rs.getString("type") ?? "TEXT",
            nullable: rs.getNumber("notnull") === 0,
            defaultValue: rs.getString("dflt_value"),
            primaryKey: (rs.getNumber("pk") ?? 0) > 0,
            unique: uniqueColumns.has(columnName),
            maxLength: null,
          });
        }
        return columns;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  async getPrimaryKeys(tableName: string, schema?: string): Promise<string[]> {
    const safeName = validateIdentifier(tableName);
    const stmt = this.connection.createStatement();
    try {
      const rs = await stmt.executeQuery(`PRAGMA table_info(${safeName})`);
      try {
        const keys: string[] = [];
        while (await rs.next()) {
          if ((rs.getNumber("pk") ?? 0) > 0) {
            keys.push(rs.getString("name")!);
          }
        }
        return keys;
      } finally {
        await rs.close();
      }
    } finally {
      await stmt.close();
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const ps = this.connection.prepareStatement(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $1`,
    );
    ps.setParameter(1, tableName);
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

  private async getUniqueColumns(tableName: string): Promise<Set<string>> {
    const safeName = validateIdentifier(tableName);
    const stmt = this.connection.createStatement();
    try {
      // Get list of unique indexes
      const indexRs = await stmt.executeQuery(`PRAGMA index_list(${safeName})`);
      const uniqueIndexNames: string[] = [];
      try {
        while (await indexRs.next()) {
          if (indexRs.getNumber("unique") === 1) {
            uniqueIndexNames.push(indexRs.getString("name")!);
          }
        }
      } finally {
        await indexRs.close();
      }

      // For each unique index, check if it's a single-column index
      const uniqueColumns = new Set<string>();
      for (const indexName of uniqueIndexNames) {
        const safeIndexName = validateIdentifier(indexName);
        const infoRs = await stmt.executeQuery(`PRAGMA index_info(${safeIndexName})`);
        try {
          const cols: string[] = [];
          while (await infoRs.next()) {
            cols.push(infoRs.getString("name")!);
          }
          // Only mark as unique if it's a single-column unique index
          if (cols.length === 1) {
            uniqueColumns.add(cols[0]);
          }
        } finally {
          await infoRs.close();
        }
      }

      return uniqueColumns;
    } finally {
      await stmt.close();
    }
  }
}
