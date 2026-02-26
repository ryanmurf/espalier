import type { PoolConnection as MysqlPoolConnection, ResultSetHeader } from "mysql2/promise";
import type { BatchStatement, SqlValue } from "espalier-jdbc";
import { QueryError, convertPositionalParams } from "espalier-jdbc";
import { mapMysqlErrorCode } from "./error-codes.js";

export class MysqlBatchStatement implements BatchStatement {
  private readonly batches: SqlValue[][] = [];
  private currentParams = new Map<number, SqlValue>();

  constructor(
    private readonly connection: MysqlPoolConnection,
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

    for (const row of this.batches) {
      const placeholders: string[] = [];
      for (let colIdx = 0; colIdx < colsPerRow; colIdx++) {
        placeholders.push("?");
        allParams.push(row[colIdx] ?? null);
      }
      valueClauses.push(`(${placeholders.join(", ")})`);
    }

    // Replace the VALUES (...) clause with multi-row version
    // Regex handles one level of nested parens (e.g., COALESCE($1, 0))
    const baseSql = convertPositionalParams(this.sql);
    const multiSql = baseSql.replace(
      /VALUES\s*\((?:[^)(]|\([^)]*\))*\)/i,
      `VALUES ${valueClauses.join(", ")}`,
    );

    try {
      const [result] = await this.connection.query(multiSql, allParams);
      const totalRows = (result as ResultSetHeader).affectedRows ?? this.batches.length;
      return new Array<number>(this.batches.length).fill(
        Math.floor(totalRows / this.batches.length),
      );
    } catch (err) {
      throw new QueryError(
        `Failed to execute batch insert: ${(err as Error).message}`,
        multiSql,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  private async executeIndividual(): Promise<number[]> {
    const results: number[] = [];
    const mysqlSql = convertPositionalParams(this.sql);

    for (const row of this.batches) {
      try {
        const [result] = await this.connection.execute(mysqlSql, row);
        results.push((result as ResultSetHeader).affectedRows ?? 0);
      } catch (err) {
        throw new QueryError(
          `Failed to execute batch statement: ${(err as Error).message}`,
          mysqlSql,
          err as Error,
          mapMysqlErrorCode(err),
        );
      }
    }

    return results;
  }
}
