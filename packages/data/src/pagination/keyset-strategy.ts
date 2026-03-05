import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";
import type { SelectBuilder } from "../query/query-builder.js";
import type { KeysetPageable, KeysetPage, PaginationStrategy } from "./types.js";

/**
 * Options for configuring the keyset pagination strategy.
 */
export interface KeysetStrategyOptions {
  /** The primary key column name for tie-breaking. */
  idColumn: string;
  /**
   * ID field name on the entity (for extracting values from rows).
   * Default: "id".
   */
  idField?: string;
  /** Maximum allowed page size. Default: 1000. */
  maxPageSize?: number;
  /**
   * Allowlist of sort column names. If provided, sortColumn is validated
   * against this set. If not provided, sortColumn is validated to contain
   * only alphanumeric and underscore characters.
   */
  allowedSortColumns?: Set<string>;
}

/**
 * Keyset (seek) pagination strategy.
 *
 * Uses WHERE-based filtering instead of OFFSET for efficient deep pagination.
 * Forward-only — does not support arbitrary page jumps.
 *
 * SQL pattern:
 *   WHERE (sort_col, id) > (:last_val, :last_id) ORDER BY sort_col, id LIMIT :size
 *
 * Uses expanded AND/OR form for dialect portability:
 *   WHERE sort_col > :val OR (sort_col = :val AND id > :id)
 */
export class KeysetPaginationStrategy
  implements PaginationStrategy<KeysetPageable, KeysetPage<unknown>>
{
  readonly name = "keyset";

  private readonly idColumn: string;
  private readonly idField: string;
  private readonly maxPageSize: number;
  private readonly allowedSortColumns: Set<string> | undefined;

  constructor(options: KeysetStrategyOptions) {
    this.idColumn = options.idColumn;
    this.idField = options.idField ?? "id";
    this.maxPageSize = options.maxPageSize ?? 1000;
    this.allowedSortColumns = options.allowedSortColumns;
  }

  applyToQuery(builder: SelectBuilder, request: KeysetPageable): void {
    const sortCol = request.sortColumn;
    this.validateSortColumn(sortCol);
    const sortDir = request.sortDirection;

    if (request.afterValue != null && request.afterId != null) {
      this.applyCursorCondition(
        builder,
        sortCol,
        sortDir,
        request.afterValue as SqlValue,
        request.afterId as SqlValue,
      );
    }

    // Apply ordering: sort column first, then id for tie-breaking
    builder.orderBy(sortCol, sortDir);
    if (sortCol !== this.idColumn) {
      builder.orderBy(this.idColumn, sortDir);
    }

    // Fetch one extra row to determine hasNext; clamp to maxPageSize
    const size = Math.min(request.size, this.maxPageSize);
    builder.limit(size + 1);
  }

  private validateSortColumn(sortColumn: string): void {
    if (this.allowedSortColumns) {
      if (!this.allowedSortColumns.has(sortColumn)) {
        throw new Error(`Invalid sortColumn: ${JSON.stringify(sortColumn)}`);
      }
    } else {
      if (!sortColumn || !/^[a-zA-Z0-9_]+$/.test(sortColumn)) {
        throw new Error(`Invalid sortColumn: ${JSON.stringify(sortColumn)}`);
      }
    }
  }

  buildResult<T>(rows: T[], request: KeysetPageable, _totalCount: number): KeysetPage<T> {
    const size = Math.min(request.size, this.maxPageSize);
    const hasNext = rows.length > size;
    if (hasNext) {
      rows = rows.slice(0, size);
    }

    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    const lastValue = lastRow
      ? this.extractField(lastRow, request.sortColumn)
      : null;
    const lastId = lastRow
      ? this.extractField(lastRow, this.idField, this.idColumn)
      : null;

    return {
      content: rows,
      size,
      hasNext,
      lastValue,
      lastId,
    };
  }

  private applyCursorCondition(
    builder: SelectBuilder,
    sortColumn: string,
    sortDirection: "ASC" | "DESC",
    afterValue: SqlValue,
    afterId: SqlValue,
  ): void {
    const sortCol = quoteIdentifier(sortColumn);
    const idCol = quoteIdentifier(this.idColumn);
    const isSameColumn = sortColumn === this.idColumn;
    const op = sortDirection === "ASC" ? ">" : "<";

    if (isSameColumn) {
      // Single column: simple comparison
      const cursorParams: SqlValue[] = [afterValue];
      builder.and({
        type: "raw" as any,
        toSql(paramOffset: number) {
          return {
            sql: `${sortCol} ${op} $${paramOffset}`,
            params: cursorParams,
          };
        },
      });
    } else {
      // Composite: expanded form for portability
      // (sort_col > :val) OR (sort_col = :val AND id > :id)
      const cursorParams: SqlValue[] = [afterValue, afterValue, afterId];
      builder.and({
        type: "raw" as any,
        toSql(paramOffset: number) {
          const sql =
            `(${sortCol} ${op} $${paramOffset} OR ` +
            `(${sortCol} = $${paramOffset + 1} AND ${idCol} ${op} $${paramOffset + 2}))`;
          return { sql, params: cursorParams };
        },
      });
    }
  }

  /**
   * Extract a field value from a row, trying the column name, its camelCase form,
   * and an optional fallback. Uses `in` operator to distinguish null from missing.
   */
  private extractField(row: unknown, field: string, fallbackField?: string): unknown {
    const obj = row as Record<string, unknown>;
    if (field in obj) return obj[field];
    const camel = this.toCamelCase(field);
    if (camel !== field && camel in obj) return obj[camel];
    if (fallbackField !== undefined) {
      if (fallbackField in obj) return obj[fallbackField];
      const camelFallback = this.toCamelCase(fallbackField);
      if (camelFallback !== fallbackField && camelFallback in obj) return obj[camelFallback];
    }
    return null;
  }

  private toCamelCase(snakeCase: string): string {
    return snakeCase.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}
