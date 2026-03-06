import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";

export class TemporalQueryBuilder {
  constructor(
    _entityTable: string,
    private historyTable: string,
    private options: { validFromColumn: string; validToColumn: string },
  ) {}

  findAsOf(timestamp: Date | string): { sql: string; params: SqlValue[] } {
    const table = quoteIdentifier(this.historyTable);
    const validFrom = quoteIdentifier(this.options.validFromColumn);
    const validTo = quoteIdentifier(this.options.validToColumn);
    const param = timestamp instanceof Date ? timestamp.toISOString() : timestamp;

    const sql = `SELECT * FROM ${table} WHERE ${validFrom} <= $1 AND (${validTo} > $1 OR ${validTo} IS NULL)`;

    return { sql, params: [param] };
  }

  findHistory(startDate: Date | string, endDate: Date | string): { sql: string; params: SqlValue[] } {
    const table = quoteIdentifier(this.historyTable);
    const validFrom = quoteIdentifier(this.options.validFromColumn);
    const startParam = startDate instanceof Date ? startDate.toISOString() : startDate;
    const endParam = endDate instanceof Date ? endDate.toISOString() : endDate;

    const sql = `SELECT * FROM ${table} WHERE ${validFrom} >= $1 AND ${validFrom} <= $2 ORDER BY ${validFrom}`;

    return { sql, params: [startParam, endParam] };
  }

  findHistoryById(id: SqlValue, startDate: Date | string, endDate: Date | string): { sql: string; params: SqlValue[] } {
    const table = quoteIdentifier(this.historyTable);
    const validFrom = quoteIdentifier(this.options.validFromColumn);
    const startParam = startDate instanceof Date ? startDate.toISOString() : startDate;
    const endParam = endDate instanceof Date ? endDate.toISOString() : endDate;

    const sql = `SELECT * FROM ${table} WHERE "id" = $1 AND ${validFrom} >= $2 AND ${validFrom} <= $3 ORDER BY ${validFrom}`;

    return { sql, params: [id, startParam, endParam] };
  }
}
