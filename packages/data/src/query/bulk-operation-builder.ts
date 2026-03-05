import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";

/**
 * Supported SQL dialects for bulk operations.
 */
export type BulkDialect = "postgres" | "mysql" | "sqlite";

/**
 * Options for bulk operations.
 */
export interface BulkOperationOptions {
  /** SQL dialect. Default: "postgres". */
  dialect?: BulkDialect;
  /** Maximum rows per batch. Default: 1000. */
  chunkSize?: number;
  /** Columns to return (RETURNING clause). Postgres only. */
  returning?: string[];
}

/**
 * A built bulk query with its parameterized SQL and values.
 */
export interface BulkQuery {
  sql: string;
  params: SqlValue[];
}

/**
 * Generates multi-row INSERT, UPDATE, and UPSERT SQL statements.
 *
 * Instead of N separate INSERT statements, generates a single:
 *   INSERT INTO t (cols) VALUES (...), (...), (...)
 *
 * For large arrays, chunks into configurable batch sizes.
 */
export class BulkOperationBuilder {
  private readonly dialect: BulkDialect;
  private readonly chunkSize: number;
  private readonly returning: string[];

  constructor(options?: BulkOperationOptions) {
    this.dialect = options?.dialect ?? "postgres";
    this.chunkSize = options?.chunkSize ?? 1000;
    this.returning = options?.returning ?? [];
  }

  /**
   * Build multi-row INSERT statements, chunked by chunkSize.
   * Returns one BulkQuery per chunk.
   */
  buildBulkInsert(
    table: string,
    columns: string[],
    rows: SqlValue[][],
  ): BulkQuery[] {
    if (rows.length === 0) return [];

    const chunks = this.chunk(rows);
    return chunks.map((chunk) => this.buildInsertChunk(table, columns, chunk));
  }

  /**
   * Build multi-row UPSERT statements (INSERT ... ON CONFLICT).
   *
   * @param conflictColumns - Columns that form the unique constraint for conflict detection.
   * @param updateColumns - Columns to update on conflict. If empty, does nothing on conflict.
   */
  buildBulkUpsert(
    table: string,
    columns: string[],
    rows: SqlValue[][],
    conflictColumns: string[],
    updateColumns: string[],
  ): BulkQuery[] {
    if (rows.length === 0) return [];

    const chunks = this.chunk(rows);
    return chunks.map((chunk) =>
      this.buildUpsertChunk(table, columns, chunk, conflictColumns, updateColumns),
    );
  }

  /**
   * Build CASE-based bulk UPDATE statements.
   *
   * Each row must include the ID value as the first element.
   *
   * @param idColumn - The primary key column for matching rows.
   * @param updateColumns - Columns to update (excluding the ID column).
   * @param rows - Each row: [idValue, ...updateValues] in same order as updateColumns.
   */
  buildBulkUpdate(
    table: string,
    idColumn: string,
    updateColumns: string[],
    rows: SqlValue[][],
  ): BulkQuery[] {
    if (rows.length === 0) return [];

    const chunks = this.chunk(rows);
    return chunks.map((chunk) =>
      this.buildUpdateChunk(table, idColumn, updateColumns, chunk),
    );
  }

  private buildInsertChunk(
    table: string,
    columns: string[],
    rows: SqlValue[][],
  ): BulkQuery {
    const quotedCols = columns.map((c) => quoteIdentifier(c)).join(", ");
    const params: SqlValue[] = [];
    const valueGroups: string[] = [];

    for (const row of rows) {
      const placeholders: string[] = [];
      for (const val of row) {
        params.push(val);
        placeholders.push(`$${params.length}`);
      }
      valueGroups.push(`(${placeholders.join(", ")})`);
    }

    let sql = `INSERT INTO ${quoteIdentifier(table)} (${quotedCols}) VALUES ${valueGroups.join(", ")}`;

    if (this.returning.length > 0 && this.dialect === "postgres") {
      sql += ` RETURNING ${this.returning.map((c) => quoteIdentifier(c)).join(", ")}`;
    }

    return { sql, params };
  }

  private buildUpsertChunk(
    table: string,
    columns: string[],
    rows: SqlValue[][],
    conflictColumns: string[],
    updateColumns: string[],
  ): BulkQuery {
    const insert = this.buildInsertChunk(table, columns, rows);

    if (this.dialect === "mysql") {
      // MySQL: INSERT ... ON DUPLICATE KEY UPDATE col = VALUES(col)
      if (updateColumns.length === 0) {
        insert.sql += ` ON DUPLICATE KEY UPDATE ${quoteIdentifier(conflictColumns[0])} = ${quoteIdentifier(conflictColumns[0])}`;
      } else {
        const updates = updateColumns.map(
          (c) => `${quoteIdentifier(c)} = VALUES(${quoteIdentifier(c)})`,
        );
        insert.sql += ` ON DUPLICATE KEY UPDATE ${updates.join(", ")}`;
      }
    } else {
      // Postgres / SQLite: INSERT ... ON CONFLICT (cols) DO UPDATE SET / DO NOTHING
      const conflictCols = conflictColumns.map((c) => quoteIdentifier(c)).join(", ");

      if (updateColumns.length === 0) {
        insert.sql += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
      } else {
        const updates = updateColumns.map(
          (c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`,
        );
        insert.sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updates.join(", ")}`;
      }
    }

    return insert;
  }

  private buildUpdateChunk(
    table: string,
    idColumn: string,
    updateColumns: string[],
    rows: SqlValue[][],
  ): BulkQuery {
    // CASE-based bulk update:
    // UPDATE t SET
    //   col1 = CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 END,
    //   col2 = CASE id WHEN $1 THEN $5 WHEN $3 THEN $6 END
    // WHERE id IN ($1, $3)

    const params: SqlValue[] = [];
    const idQuoted = quoteIdentifier(idColumn);

    // Assign parameter indices for IDs first
    const idParamIndices: number[] = [];
    for (const row of rows) {
      params.push(row[0]);
      idParamIndices.push(params.length);
    }

    const setClauses: string[] = [];
    for (let colIdx = 0; colIdx < updateColumns.length; colIdx++) {
      const col = quoteIdentifier(updateColumns[colIdx]);
      const whenClauses: string[] = [];
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const value = rows[rowIdx][colIdx + 1]; // +1 because row[0] is id
        params.push(value);
        whenClauses.push(`WHEN $${idParamIndices[rowIdx]} THEN $${params.length}`);
      }
      setClauses.push(`${col} = CASE ${idQuoted} ${whenClauses.join(" ")} END`);
    }

    const inList = idParamIndices.map((i) => `$${i}`).join(", ");
    let sql = `UPDATE ${quoteIdentifier(table)} SET ${setClauses.join(", ")} WHERE ${idQuoted} IN (${inList})`;

    if (this.returning.length > 0 && this.dialect === "postgres") {
      sql += ` RETURNING ${this.returning.map((c) => quoteIdentifier(c)).join(", ")}`;
    }

    return { sql, params };
  }

  private chunk(rows: SqlValue[][]): SqlValue[][][] {
    if (rows.length <= this.chunkSize) return [rows];
    const chunks: SqlValue[][][] = [];
    for (let i = 0; i < rows.length; i += this.chunkSize) {
      chunks.push(rows.slice(i, i + this.chunkSize));
    }
    return chunks;
  }
}
