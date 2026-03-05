import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";
import type { SelectBuilder } from "../query/query-builder.js";
import { RawComparisonCriteria } from "../query/criteria.js";
import type { CursorPageable, CursorPage, Edge, PageInfo, PaginationStrategy } from "./types.js";
import { encodeCursor, decodeCursor } from "./cursor-encoding.js";
import type { CursorPayload } from "./cursor-encoding.js";

/**
 * Options for configuring the Relay cursor strategy.
 */
export interface RelayCursorStrategyOptions {
  /** The primary key column name. Required for tie-breaking. */
  idColumn: string;
  /**
   * The column(s) to sort by for cursor ordering.
   * Default: [idColumn] (sorted by primary key only).
   */
  sortColumns?: Array<{ column: string; direction: "ASC" | "DESC" }>;
  /**
   * ID field name on the entity (for extracting cursor values from rows).
   * Default: "id".
   */
  idField?: string;
}

/**
 * Relay-style cursor pagination strategy.
 *
 * Implements the Relay Connection spec:
 * - `first` + `after`: forward pagination
 * - `last` + `before`: backward pagination
 *
 * Cursors encode the sort column values + primary key as base64 JSON.
 * Pagination is stable under insertions/deletions.
 */
export class RelayCursorStrategy implements PaginationStrategy<CursorPageable, CursorPage<unknown>> {
  readonly name = "cursor";

  private readonly idColumn: string;
  private readonly sortColumns: Array<{ column: string; direction: "ASC" | "DESC" }>;
  private readonly idField: string;

  constructor(options: RelayCursorStrategyOptions) {
    this.idColumn = options.idColumn;
    this.idField = options.idField ?? "id";
    this.sortColumns = options.sortColumns ?? [
      { column: options.idColumn, direction: "ASC" },
    ];
  }

  applyToQuery(builder: SelectBuilder, request: CursorPageable): void {
    const isBackward = request.last != null && request.last > 0;
    const cursorStr = isBackward ? request.before : request.after;

    if (cursorStr) {
      const payload = decodeCursor(cursorStr);
      this.applyCursorCondition(builder, payload, isBackward);
    }

    // Apply ordering
    for (const col of this.sortColumns) {
      const effectiveDir = isBackward
        ? (col.direction === "ASC" ? "DESC" : "ASC")
        : col.direction;
      builder.orderBy(col.column, effectiveDir);
    }

    // If the sort doesn't already include the ID column, add it for tie-breaking
    const sortHasId = this.sortColumns.some((c) => c.column === this.idColumn);
    if (!sortHasId) {
      builder.orderBy(this.idColumn, isBackward ? "DESC" : "ASC");
    }

    // Limit: fetch one extra to determine hasNextPage/hasPreviousPage
    const limit = isBackward ? (request.last ?? 10) : (request.first ?? 10);
    builder.limit(limit + 1);
  }

  buildResult<T>(rows: T[], request: CursorPageable, totalCount: number): CursorPage<T> {
    const isBackward = request.last != null && request.last > 0;
    const limit = isBackward ? (request.last ?? 10) : (request.first ?? 10);

    // If we got more rows than the limit, there are more pages
    const hasMore = rows.length > limit;
    if (hasMore) {
      rows = rows.slice(0, limit);
    }

    // For backward pagination, reverse the results to restore original order
    if (isBackward) {
      rows.reverse();
    }

    // Build edges with cursors
    const edges: Edge<T>[] = rows.map((node) => ({
      node,
      cursor: this.buildCursorForRow(node),
    }));

    const pageInfo: PageInfo = {
      hasNextPage: isBackward ? (request.before != null) : hasMore,
      hasPreviousPage: isBackward ? hasMore : (request.after != null),
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    };

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  private applyCursorCondition(
    builder: SelectBuilder,
    payload: CursorPayload,
    isBackward: boolean,
  ): void {
    // Build a composite cursor condition:
    // For forward (after): (col1, col2, id) > (val1, val2, idVal)
    // For backward (before): (col1, col2, id) < (val1, val2, idVal)
    //
    // Using row-value comparison: (a, b) > (x, y) is standard SQL
    // but not all databases support it. Fall back to expanded form.

    const columns = this.sortColumns.map((c) => quoteIdentifier(c.column));
    const sortHasId = this.sortColumns.some((c) => c.column === this.idColumn);
    if (!sortHasId) {
      columns.push(quoteIdentifier(this.idColumn));
    }

    const values = [...payload.values];
    if (!sortHasId) {
      values.push(payload.id);
    }

    // Build expanded form for portability:
    // (a > x) OR (a = x AND b > y) OR (a = x AND b = y AND id > idVal)
    // Direction depends on sort direction and backward/forward
    const parts: string[] = [];
    const params: SqlValue[] = [];
    let paramIdx = 1000; // Use high offset to avoid collision with existing params

    for (let depth = 0; depth < columns.length; depth++) {
      const conditions: string[] = [];

      // All previous columns must be equal
      for (let j = 0; j < depth; j++) {
        conditions.push(`${columns[j]} = $__cursor_${j}__`);
      }

      // Current column comparison
      const col = columns[depth];
      const sortDir = depth < this.sortColumns.length
        ? this.sortColumns[depth].direction
        : "ASC"; // ID column default

      let op: string;
      if (isBackward) {
        op = sortDir === "ASC" ? "<" : ">";
      } else {
        op = sortDir === "ASC" ? ">" : "<";
      }

      conditions.push(`${col} ${op} $__cursor_${depth}__`);
      parts.push(`(${conditions.join(" AND ")})`);
    }

    // Build as raw SQL with embedded cursor parameters
    // We use RawComparisonCriteria-style approach but build raw SQL
    const whereSql = parts.join(" OR ");

    // Replace placeholders with actual parameter indices
    let finalSql = whereSql;
    const cursorParams: SqlValue[] = [];
    for (let i = 0; i < values.length; i++) {
      // Each cursor value may appear multiple times in the expanded form
      // We need to use a unique parameter for each occurrence
      const placeholder = `$__cursor_${i}__`;
      // Count occurrences and replace with sequential params
      let occurrence = 0;
      finalSql = finalSql.replace(new RegExp(`\\$__cursor_${i}__`, "g"), () => {
        cursorParams.push(values[i] as SqlValue);
        return `$__cursor_final_${cursorParams.length - 1}__`;
      });
    }

    // The final SQL will be injected as a raw criteria
    // We need to use the builder's raw criteria support
    builder.and({
      type: "raw" as any,
      toSql(paramOffset: number) {
        let sql = finalSql;
        const finalParams: SqlValue[] = [];
        for (let i = 0; i < cursorParams.length; i++) {
          sql = sql.replace(`$__cursor_final_${i}__`, `$${paramOffset + i}`);
          finalParams.push(cursorParams[i]);
        }
        return { sql: `(${sql})`, params: finalParams };
      },
    });
  }

  private buildCursorForRow<T>(row: T): string {
    const values: unknown[] = [];
    for (const col of this.sortColumns) {
      const obj = row as Record<string, unknown>;
      const val = col.column in obj ? obj[col.column] : obj[this.toCamelCase(col.column)];
      values.push(val);
    }
    const obj = row as Record<string, unknown>;
    const id = this.idField in obj ? obj[this.idField]
      : this.idColumn in obj ? obj[this.idColumn]
      : null;
    return encodeCursor({ values, id });
  }

  private toCamelCase(snakeCase: string): string {
    return snakeCase.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}
