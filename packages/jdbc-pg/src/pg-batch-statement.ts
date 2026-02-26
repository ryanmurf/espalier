import type { PoolClient } from "pg";
import type { BatchStatement, SqlValue } from "espalier-jdbc";
import { QueryError, DatabaseErrorCode } from "espalier-jdbc";

function mapPgErrorCode(err: unknown): DatabaseErrorCode {
  if (err == null) return DatabaseErrorCode.QUERY_FAILED;
  const code = (err as { code?: string }).code;
  switch (code) {
    case "23505":
    case "23503":
    case "23502":
    case "23514":
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case "42601":
    case "42P01":
    case "42703":
      return DatabaseErrorCode.QUERY_SYNTAX;
    default:
      return DatabaseErrorCode.QUERY_FAILED;
  }
}

export class PgBatchStatement implements BatchStatement {
  private readonly batches: SqlValue[][] = [];
  private currentParams = new Map<number, SqlValue>();

  constructor(
    private readonly client: PoolClient,
    private readonly sql: string,
  ) {}

  setParameter(index: number, value: SqlValue): void {
    this.currentParams.set(index, value);
  }

  addBatch(): void {
    const maxIndex = Math.max(...this.currentParams.keys(), 0);
    const row: SqlValue[] = [];
    for (let i = 1; i <= maxIndex; i++) {
      row.push(this.currentParams.get(i) ?? null);
    }
    this.batches.push(row);
    this.currentParams.clear();
  }

  async executeBatch(): Promise<number[]> {
    if (this.batches.length === 0) {
      return [];
    }

    if (this.isInsert()) {
      return this.executeMultiRowInsert();
    }

    return this.executeIndividual();
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }

  private isInsert(): boolean {
    return /^\s*INSERT\s+INTO\s/i.test(this.sql);
  }

  private async executeMultiRowInsert(): Promise<number[]> {
    const colsPerRow = this.batches[0].length;
    const allParams: SqlValue[] = [];
    const valueClauses: string[] = [];

    for (let rowIdx = 0; rowIdx < this.batches.length; rowIdx++) {
      const row = this.batches[rowIdx];
      const placeholders: string[] = [];
      for (let colIdx = 0; colIdx < colsPerRow; colIdx++) {
        const paramNum = rowIdx * colsPerRow + colIdx + 1;
        placeholders.push(`$${paramNum}`);
        allParams.push(row[colIdx] ?? null);
      }
      valueClauses.push(`(${placeholders.join(", ")})`);
    }

    // Replace the VALUES (...) clause with multi-row version
    const multiSql = this.sql.replace(
      /VALUES\s*\([^)]*\)/i,
      `VALUES ${valueClauses.join(", ")}`,
    );

    try {
      const result = await this.client.query(multiSql, allParams);
      const totalRows = result.rowCount ?? this.batches.length;
      return new Array<number>(this.batches.length).fill(
        Math.floor(totalRows / this.batches.length),
      );
    } catch (err) {
      throw new QueryError(
        `Failed to execute batch insert: ${(err as Error).message}`,
        multiSql,
        err as Error,
        mapPgErrorCode(err),
      );
    }
  }

  private async executeIndividual(): Promise<number[]> {
    const results: number[] = [];

    for (const row of this.batches) {
      try {
        const result = await this.client.query(this.sql, row);
        results.push(result.rowCount ?? 0);
      } catch (err) {
        throw new QueryError(
          `Failed to execute batch statement: ${(err as Error).message}`,
          this.sql,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    }

    return results;
  }
}
