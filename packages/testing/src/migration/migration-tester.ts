import type { Connection, SchemaIntrospector } from "espalier-jdbc";

export interface MigrationTestContext {
  connection: Connection;
  introspector: SchemaIntrospector;
}

export interface SchemaAssertion {
  /** Assert a table exists. */
  tableExists(tableName: string, schema?: string): Promise<void>;
  /** Assert a table does not exist. */
  tableNotExists(tableName: string, schema?: string): Promise<void>;
  /** Assert a column exists with optional type check. */
  columnExists(tableName: string, columnName: string, expectedType?: string): Promise<void>;
  /** Assert a column does not exist. */
  columnNotExists(tableName: string, columnName: string): Promise<void>;
  /** Assert a column is nullable. */
  columnIsNullable(tableName: string, columnName: string): Promise<void>;
  /** Assert a column is NOT nullable. */
  columnIsNotNullable(tableName: string, columnName: string): Promise<void>;
  /** Assert a primary key exists. */
  primaryKeyExists(tableName: string, columns: string[]): Promise<void>;
}

/**
 * Create a SchemaAssertion instance from an introspector.
 */
export function createSchemaAssertion(introspector: SchemaIntrospector): SchemaAssertion {
  return {
    async tableExists(tableName: string, schema?: string): Promise<void> {
      const exists = await introspector.tableExists(tableName, schema);
      if (!exists) {
        throw new Error(`Expected table '${tableName}' to exist, but it does not.`);
      }
    },

    async tableNotExists(tableName: string, schema?: string): Promise<void> {
      const exists = await introspector.tableExists(tableName, schema);
      if (exists) {
        throw new Error(`Expected table '${tableName}' not to exist, but it does.`);
      }
    },

    async columnExists(tableName: string, columnName: string, expectedType?: string): Promise<void> {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column) {
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      }
      if (expectedType !== undefined) {
        const actual = column.dataType.trim().toLowerCase();
        const expected = expectedType.trim().toLowerCase();
        if (actual !== expected) {
          throw new Error(
            `Expected column '${columnName}' on table '${tableName}' to have type '${expectedType}', but it has type '${column.dataType}'.`,
          );
        }
      }
    },

    async columnNotExists(tableName: string, columnName: string): Promise<void> {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (column) {
        throw new Error(`Expected column '${columnName}' not to exist on table '${tableName}', but it does.`);
      }
    },

    async columnIsNullable(tableName: string, columnName: string): Promise<void> {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column) {
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      }
      if (!column.nullable) {
        throw new Error(`Expected column '${columnName}' on table '${tableName}' to be nullable, but it is NOT NULL.`);
      }
    },

    async columnIsNotNullable(tableName: string, columnName: string): Promise<void> {
      const columns = await introspector.getColumns(tableName);
      const column = columns.find((c) => c.columnName.toLowerCase() === columnName.toLowerCase());
      if (!column) {
        throw new Error(`Expected column '${columnName}' to exist on table '${tableName}', but it does not.`);
      }
      if (column.nullable) {
        throw new Error(`Expected column '${columnName}' on table '${tableName}' to be NOT NULL, but it is nullable.`);
      }
    },

    async primaryKeyExists(tableName: string, columns: string[]): Promise<void> {
      const pkColumns = await introspector.getPrimaryKeys(tableName);
      const normalizedExpected = columns.map((c) => c.toLowerCase()).sort();
      const normalizedActual = pkColumns.map((c) => c.toLowerCase()).sort();

      if (
        normalizedExpected.length !== normalizedActual.length ||
        !normalizedExpected.every((col, i) => col === normalizedActual[i])
      ) {
        throw new Error(
          `Expected primary key on table '${tableName}' to be [${columns.join(", ")}], but got [${pkColumns.join(", ")}].`,
        );
      }
    },
  };
}

/**
 * Run migration SQL in a transaction, execute assertions, then rollback.
 * The migration is never permanently applied.
 */
export async function testMigration(
  ctx: MigrationTestContext,
  upSql: string | string[],
  assertions: (assert: SchemaAssertion) => Promise<void>,
): Promise<void> {
  const statements = Array.isArray(upSql) ? upSql : [upSql];
  const transaction = await ctx.connection.beginTransaction();

  try {
    const stmt = ctx.connection.createStatement();
    for (const sql of statements) {
      await stmt.executeUpdate(sql);
    }

    const assert = createSchemaAssertion(ctx.introspector);
    await assertions(assert);
  } finally {
    await transaction.rollback();
  }
}
