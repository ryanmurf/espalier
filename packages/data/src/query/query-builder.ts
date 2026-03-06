import { quoteIdentifier, type SqlValue } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { HighlightOptions, SearchOptions } from "../search/search-criteria.js";
import { FullTextSearchCriteria, SearchHighlightExpression, SearchRankExpression } from "../search/search-criteria.js";
import type { Criteria } from "./criteria.js";
import { LogicalCriteria } from "./criteria.js";

export type JoinType = "INNER" | "LEFT" | "RIGHT";
export type SortDirection = "ASC" | "DESC";

// ── Window Function Types ───────────────────────────────────────────────

const ALLOWED_WINDOW_FUNCTIONS = new Set([
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "SUM",
  "AVG",
  "COUNT",
  "MIN",
  "MAX",
]);

export type FrameBoundType = "UNBOUNDED PRECEDING" | "CURRENT ROW" | "UNBOUNDED FOLLOWING" | "PRECEDING" | "FOLLOWING";

export interface FrameBound {
  type: FrameBoundType;
  offset?: number;
}

export interface FrameSpec {
  type: "ROWS" | "RANGE" | "GROUPS";
  start: FrameBound;
  end?: FrameBound;
}

export interface WindowSpec {
  partitionBy?: string[];
  orderBy?: Array<{ column: string; direction: SortDirection }>;
  frame?: FrameSpec;
}

export interface WindowFunctionDef {
  function: string;
  args?: string[];
  over: WindowSpec | string;
  alias: string;
}

// ── CTE Types ───────────────────────────────────────────────────────────

interface CteDef {
  name: string;
  query: SelectBuilder | string;
  recursive?: {
    recursiveQuery: SelectBuilder | string;
    unionAll: boolean;
  };
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateCteName(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`);
  }
}

function buildFrameBound(bound: FrameBound): string {
  if (bound.type === "PRECEDING" || bound.type === "FOLLOWING") {
    if (bound.offset == null || !Number.isFinite(bound.offset) || bound.offset < 0) {
      throw new Error(`Frame bound ${bound.type} requires a non-negative finite offset.`);
    }
    return `${bound.offset} ${bound.type}`;
  }
  return bound.type;
}

function buildWindowSpecSql(spec: WindowSpec): string {
  const specParts: string[] = [];
  if (spec.partitionBy && spec.partitionBy.length > 0) {
    specParts.push(`PARTITION BY ${spec.partitionBy.map((c) => quoteIdentifier(c)).join(", ")}`);
  }
  if (spec.orderBy && spec.orderBy.length > 0) {
    const orderClauses = spec.orderBy.map((o) => {
      const dir = String(o.direction).toUpperCase();
      if (dir !== "ASC" && dir !== "DESC") {
        throw new Error(`Invalid sort direction: ${o.direction}. Must be "ASC" or "DESC".`);
      }
      return `${quoteIdentifier(o.column)} ${dir}`;
    });
    specParts.push(`ORDER BY ${orderClauses.join(", ")}`);
  }
  if (spec.frame) {
    const frameType = spec.frame.type;
    if (frameType !== "ROWS" && frameType !== "RANGE" && frameType !== "GROUPS") {
      throw new Error(`Invalid frame type: ${frameType}. Must be "ROWS", "RANGE", or "GROUPS".`);
    }
    const start = buildFrameBound(spec.frame.start);
    if (spec.frame.end) {
      specParts.push(`${frameType} BETWEEN ${start} AND ${buildFrameBound(spec.frame.end)}`);
    } else {
      specParts.push(`${frameType} ${start}`);
    }
  }
  return specParts.join(" ");
}

function buildCteQuery(query: SelectBuilder | string, paramOffset: number): { sql: string; params: SqlValue[] } {
  if (typeof query === "string") {
    return { sql: query, params: [] };
  }
  const built = query.build();
  // Re-number parameters from the given offset
  let sql = built.sql;
  const params = built.params;
  if (params.length > 0) {
    // Replace $1, $2, ... with $offset, $offset+1, ...
    sql = sql.replace(/\$(\d+)/g, (_match, num) => `$${parseInt(num, 10) + paramOffset - 1}`);
  }
  return { sql, params };
}

/**
 * Interface for expression-based ORDER BY clauses (e.g. vector distance).
 * The expression generates parameterized SQL given a starting param offset.
 */
export interface OrderByExpressionArg {
  toSql(paramOffset: number): { sql: string; params: SqlValue[] };
  direction: "ASC" | "DESC";
}

export interface BuiltQuery {
  sql: string;
  params: SqlValue[];
}

interface JoinClause {
  type: JoinType;
  table: string;
  alias?: string;
  on: string;
}

interface OrderByClause {
  column: string;
  direction: SortDirection;
}

export class SelectBuilder {
  private _columns: string[] = ["*"];
  private _from: string;
  private _joins: JoinClause[] = [];
  private _where: Criteria | undefined;
  private _orderBy: OrderByClause[] = [];
  private _groupBy: string[] = [];
  private _having: Criteria | undefined;
  private _limit: number | undefined;
  private _offset: number | undefined;
  private _distinct = false;
  private _rawColumns = false;
  private _extraRawColumns: Array<{ expression: string; alias: string }> = [];
  private _rawOrderBys: Array<{ expression: string; direction: SortDirection }> = [];
  private _expressionOrderBys: OrderByExpressionArg[] = [];
  private _cacheable = false;
  private _cacheTtlMs: number | undefined;
  private _windowFunctions: WindowFunctionDef[] = [];
  private _namedWindows: Array<{ name: string; spec: WindowSpec }> = [];
  private _ctes: CteDef[] = [];
  private _searchRankExprs: Array<{ expr: SearchRankExpression; alias: string }> = [];
  private _searchHighlightExprs: Array<{ expr: SearchHighlightExpression; alias: string }> = [];

  constructor(from: string) {
    this._from = from;
  }

  distinct(): SelectBuilder {
    this._distinct = true;
    return this;
  }

  columns(...columns: string[]): SelectBuilder {
    this._columns = columns;
    this._rawColumns = false;
    return this;
  }

  /** Set columns as raw SQL expressions (not quoted). */
  rawColumns(...columns: string[]): SelectBuilder {
    this._columns = columns;
    this._rawColumns = true;
    return this;
  }

  /**
   * Add a raw SQL expression as a column with an alias.
   * Example: `addRawColumn('("embedding" <-> $1)', 'distance')`
   */
  addRawColumn(expression: string, alias: string): SelectBuilder {
    this._extraRawColumns.push({ expression, alias });
    return this;
  }

  where(criteria: Criteria): SelectBuilder {
    this._where = criteria;
    return this;
  }

  and(criteria: Criteria): SelectBuilder {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }

  or(criteria: Criteria): SelectBuilder {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("or", this._where, criteria);
    }
    return this;
  }

  join(type: JoinType, table: string, on: string, alias?: string): SelectBuilder {
    this._joins.push({ type, table, alias, on });
    return this;
  }

  orderBy(column: string, direction: SortDirection = "ASC"): SelectBuilder {
    const normalized = String(direction).toUpperCase();
    if (normalized !== "ASC" && normalized !== "DESC") {
      throw new Error(`Invalid sort direction: ${direction}. Must be "ASC" or "DESC".`);
    }
    this._orderBy.push({ column, direction: normalized as SortDirection });
    return this;
  }

  /**
   * Add a raw ORDER BY expression that will not be quoted as an identifier.
   * Example: `orderByRaw('("embedding" <-> $1)', 'ASC')`
   */
  orderByRaw(expression: string, direction: SortDirection): SelectBuilder {
    const normalized = String(direction).toUpperCase();
    if (normalized !== "ASC" && normalized !== "DESC") {
      throw new Error(`Invalid sort direction: ${direction}. Must be "ASC" or "DESC".`);
    }
    this._rawOrderBys.push({ expression, direction: normalized as SortDirection });
    return this;
  }

  /**
   * Add an expression-based ORDER BY clause that generates parameterized SQL.
   * The expression's params are merged into the query at the correct offset.
   */
  orderByExpression(expression: OrderByExpressionArg): SelectBuilder {
    this._expressionOrderBys.push(expression);
    return this;
  }

  groupBy(...columns: string[]): SelectBuilder {
    this._groupBy = columns;
    return this;
  }

  having(criteria: Criteria): SelectBuilder {
    this._having = criteria;
    return this;
  }

  limit(n: number): SelectBuilder {
    if (n < 0) throw new Error(`LIMIT must be non-negative, got ${n}`);
    this._limit = n;
    return this;
  }

  offset(n: number): SelectBuilder {
    if (n < 0) throw new Error(`OFFSET must be non-negative, got ${n}`);
    this._offset = n;
    return this;
  }

  /** Add a window function as a select column. */
  addWindowFunction(fn: WindowFunctionDef): SelectBuilder {
    const upperFn = fn.function.toUpperCase();
    if (!ALLOWED_WINDOW_FUNCTIONS.has(upperFn)) {
      throw new Error(`Invalid window function: ${fn.function}. Allowed: ${[...ALLOWED_WINDOW_FUNCTIONS].join(", ")}`);
    }
    this._windowFunctions.push({ ...fn, function: upperFn });
    return this;
  }

  /** Define a named window for reuse in OVER clauses. */
  defineWindow(name: string, spec: WindowSpec): SelectBuilder {
    validateCteName(name);
    this._namedWindows.push({ name, spec });
    return this;
  }

  /** Add a non-recursive CTE. */
  with(name: string, query: SelectBuilder | string): SelectBuilder {
    validateCteName(name);
    this._ctes.push({ name, query });
    return this;
  }

  /** Add a recursive CTE (base UNION [ALL] recursive). */
  withRecursive(
    name: string,
    baseQuery: SelectBuilder | string,
    recursiveQuery: SelectBuilder | string,
    unionAll = true,
  ): SelectBuilder {
    validateCteName(name);
    this._ctes.push({ name, query: baseQuery, recursive: { recursiveQuery, unionAll } });
    return this;
  }

  /**
   * Add a full-text search WHERE clause. The search term is always parameterized.
   * Generates PostgreSQL tsvector/tsquery syntax.
   *
   * @param query - The search query string (bound as a parameter)
   * @param options - Search options (fields, weights, language, mode)
   */
  search(query: string, options?: SearchOptions): SelectBuilder {
    const columns = options?.fields ?? [];
    if (columns.length === 0) {
      throw new Error("search() requires at least one field. Provide options.fields.");
    }
    const language = options?.language ?? "english";
    const mode = options?.mode ?? "plain";
    const criteria = new FullTextSearchCriteria(columns, language, query, mode, options?.weights);
    return this.and(criteria);
  }

  /**
   * Add a ts_rank column to the SELECT list for search result ranking.
   *
   * @param query - The search query string (bound as a parameter)
   * @param options - Search options (fields, weights, language, mode)
   * @param alias - Column alias for the rank. Default: 'search_rank'
   */
  addSearchRank(query: string, options: SearchOptions, alias = "search_rank"): SelectBuilder {
    const columns = options.fields ?? [];
    if (columns.length === 0) {
      throw new Error("addSearchRank() requires at least one field in options.fields.");
    }
    const language = options.language ?? "english";
    const mode = options.mode ?? "plain";
    const rankExpr = new SearchRankExpression(columns, language, query, mode, options.weights);
    this._searchRankExprs.push({ expr: rankExpr, alias });
    return this;
  }

  /**
   * Add a ts_headline column to the SELECT list for search result highlighting.
   *
   * @param field - The column name to highlight
   * @param query - The search query string
   * @param options - Highlight options (startTag, stopTag, etc.)
   * @param searchOptions - Search options for language and mode
   * @param alias - Column alias. Default: 'search_highlight'
   */
  addSearchHighlight(
    field: string,
    query: string,
    options?: HighlightOptions,
    searchOptions?: Pick<SearchOptions, "language" | "mode">,
    alias = "search_highlight",
  ): SelectBuilder {
    const language = searchOptions?.language ?? "english";
    const mode = searchOptions?.mode ?? "plain";
    const hlExpr = new SearchHighlightExpression(field, language, query, mode, options);
    this._searchHighlightExprs.push({ expr: hlExpr, alias });
    return this;
  }

  cacheable(ttlMs?: number): SelectBuilder {
    this._cacheable = true;
    this._cacheTtlMs = ttlMs;
    return this;
  }

  isCacheable(): boolean {
    return this._cacheable;
  }

  getCacheTtlMs(): number | undefined {
    return this._cacheTtlMs;
  }

  build(): BuiltQuery {
    const params: SqlValue[] = [];
    let paramIdx = 1;
    const parts: string[] = [];

    // ── CTEs ──────────────────────────────────────────────────────────
    if (this._ctes.length > 0) {
      const hasRecursive = this._ctes.some((c) => c.recursive != null);
      const cteParts: string[] = [];
      for (const cte of this._ctes) {
        const baseResult = buildCteQuery(cte.query, paramIdx);
        params.push(...baseResult.params);
        paramIdx += baseResult.params.length;

        if (cte.recursive) {
          const recResult = buildCteQuery(cte.recursive.recursiveQuery, paramIdx);
          params.push(...recResult.params);
          paramIdx += recResult.params.length;
          const unionKeyword = cte.recursive.unionAll ? "UNION ALL" : "UNION";
          cteParts.push(`${quoteIdentifier(cte.name)} AS (${baseResult.sql} ${unionKeyword} ${recResult.sql})`);
        } else {
          cteParts.push(`${quoteIdentifier(cte.name)} AS (${baseResult.sql})`);
        }
      }
      parts.push(`WITH${hasRecursive ? " RECURSIVE" : ""} ${cteParts.join(", ")}`);
    }

    // ── SELECT columns ───────────────────────────────────────────────
    const baseColList = this._rawColumns
      ? this._columns.join(", ")
      : this._columns.map((c) => quoteIdentifier(c)).join(", ");
    const extraCols = this._extraRawColumns.map((rc) => `${rc.expression} AS ${quoteIdentifier(rc.alias)}`);

    // Window function columns
    const winCols = this._windowFunctions.map((wf) => {
      const args = wf.args && wf.args.length > 0 ? wf.args.map((a) => quoteIdentifier(a)).join(", ") : "";
      let overClause: string;
      if (typeof wf.over === "string") {
        validateCteName(wf.over);
        overClause = quoteIdentifier(wf.over);
      } else {
        overClause = `(${buildWindowSpecSql(wf.over)})`;
      }
      return `${wf.function}(${args}) OVER ${overClause} AS ${quoteIdentifier(wf.alias)}`;
    });

    // Search rank columns (parameterized)
    const searchRankCols: string[] = [];
    for (const sr of this._searchRankExprs) {
      const result = sr.expr.toSql(paramIdx);
      searchRankCols.push(`${result.sql} AS ${quoteIdentifier(sr.alias)}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    // Search highlight columns (parameterized)
    const searchHighlightCols: string[] = [];
    for (const sh of this._searchHighlightExprs) {
      const result = sh.expr.toSql(paramIdx);
      searchHighlightCols.push(`${result.sql} AS ${quoteIdentifier(sh.alias)}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    const allColParts = [baseColList, ...extraCols, ...winCols, ...searchRankCols, ...searchHighlightCols];
    const allCols = allColParts.join(", ");
    parts.push(`SELECT ${this._distinct ? "DISTINCT " : ""}${allCols}`);
    parts.push(`FROM ${quoteIdentifier(this._from)}`);

    for (const join of this._joins) {
      const tableExpr = join.alias
        ? `${quoteIdentifier(join.table)} ${quoteIdentifier(join.alias)}`
        : quoteIdentifier(join.table);
      parts.push(`${join.type} JOIN ${tableExpr} ON ${join.on}`);
    }

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      parts.push(`WHERE ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    if (this._groupBy.length > 0) {
      parts.push(`GROUP BY ${this._groupBy.map((c) => quoteIdentifier(c)).join(", ")}`);
    }

    if (this._having) {
      const result = this._having.toSql(paramIdx);
      parts.push(`HAVING ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    // ── WINDOW clause (named windows) ────────────────────────────────
    if (this._namedWindows.length > 0) {
      const windowDefs = this._namedWindows.map(
        (nw) => `${quoteIdentifier(nw.name)} AS (${buildWindowSpecSql(nw.spec)})`,
      );
      parts.push(`WINDOW ${windowDefs.join(", ")}`);
    }

    // Build ORDER BY: regular + raw + expression-based
    const hasAnyOrderBy =
      this._orderBy.length > 0 || this._rawOrderBys.length > 0 || this._expressionOrderBys.length > 0;

    if (hasAnyOrderBy) {
      const orderClauses: string[] = [];

      for (const o of this._orderBy) {
        orderClauses.push(`${quoteIdentifier(o.column)} ${o.direction}`);
      }

      for (const ro of this._rawOrderBys) {
        orderClauses.push(`${ro.expression} ${ro.direction}`);
      }

      for (const expr of this._expressionOrderBys) {
        const result = expr.toSql(paramIdx);
        orderClauses.push(`${result.sql} ${expr.direction}`);
        params.push(...result.params);
        paramIdx += result.params.length;
      }

      parts.push(`ORDER BY ${orderClauses.join(", ")}`);
    }

    if (this._limit !== undefined) {
      parts.push(`LIMIT $${paramIdx}`);
      params.push(this._limit);
      paramIdx++;
    }

    if (this._offset !== undefined) {
      parts.push(`OFFSET $${paramIdx}`);
      params.push(this._offset);
      paramIdx++;
    }

    return { sql: parts.join(" "), params };
  }
}

export class InsertBuilder {
  private _table: string;
  private _columns: string[] = [];
  private _values: SqlValue[] = [];
  private _returning: string[] = [];

  constructor(table: string) {
    this._table = table;
  }

  set(column: string, value: SqlValue): InsertBuilder {
    this._columns.push(column);
    this._values.push(value);
    return this;
  }

  values(record: Record<string, SqlValue>): InsertBuilder {
    for (const [column, value] of Object.entries(record)) {
      this._columns.push(column);
      this._values.push(value);
    }
    return this;
  }

  returning(...columns: string[]): InsertBuilder {
    this._returning = columns;
    return this;
  }

  build(): BuiltQuery {
    const placeholders = this._columns.map((_, i) => `$${i + 1}`);
    let sql = `INSERT INTO ${quoteIdentifier(this._table)} (${this._columns.map((c) => quoteIdentifier(c)).join(", ")}) VALUES (${placeholders.join(", ")})`;

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.map((c) => quoteIdentifier(c)).join(", ")}`;
    }

    return { sql, params: [...this._values] };
  }
}

export class UpdateBuilder {
  private _table: string;
  private _sets: { column: string; value: SqlValue }[] = [];
  private _where: Criteria | undefined;
  private _returning: string[] = [];

  constructor(table: string) {
    this._table = table;
  }

  set(column: string, value: SqlValue): UpdateBuilder {
    this._sets.push({ column, value });
    return this;
  }

  values(record: Record<string, SqlValue>): UpdateBuilder {
    for (const [column, value] of Object.entries(record)) {
      this._sets.push({ column, value });
    }
    return this;
  }

  where(criteria: Criteria): UpdateBuilder {
    this._where = criteria;
    return this;
  }

  and(criteria: Criteria): UpdateBuilder {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }

  returning(...columns: string[]): UpdateBuilder {
    this._returning = columns;
    return this;
  }

  build(): BuiltQuery {
    const params: SqlValue[] = [];
    let paramIdx = 1;

    const setClauses = this._sets.map((s) => {
      params.push(s.value);
      return `${quoteIdentifier(s.column)} = $${paramIdx++}`;
    });

    let sql = `UPDATE ${quoteIdentifier(this._table)} SET ${setClauses.join(", ")}`;

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.map((c) => quoteIdentifier(c)).join(", ")}`;
    }

    return { sql, params };
  }
}

export class DeleteBuilder {
  private _table: string;
  private _where: Criteria | undefined;
  private _returning: string[] = [];

  constructor(table: string) {
    this._table = table;
  }

  where(criteria: Criteria): DeleteBuilder {
    this._where = criteria;
    return this;
  }

  and(criteria: Criteria): DeleteBuilder {
    if (!this._where) {
      this._where = criteria;
    } else {
      this._where = new LogicalCriteria("and", this._where, criteria);
    }
    return this;
  }

  returning(...columns: string[]): DeleteBuilder {
    this._returning = columns;
    return this;
  }

  build(): BuiltQuery {
    const params: SqlValue[] = [];
    const paramIdx = 1;

    let sql = `DELETE FROM ${quoteIdentifier(this._table)}`;

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.map((c) => quoteIdentifier(c)).join(", ")}`;
    }

    return { sql, params };
  }
}

function resolveTable(entityOrTable: (new (...args: any[]) => any) | string): {
  table: string;
  metadata?: EntityMetadata;
} {
  if (typeof entityOrTable === "string") {
    return { table: entityOrTable };
  }
  const metadata = getEntityMetadata(entityOrTable);
  return { table: metadata.tableName, metadata };
}

function resolveColumns(metadata: EntityMetadata): string[] {
  return metadata.fields.map((f: FieldMapping) => f.columnName);
}

export const QueryBuilder = {
  select(entityOrTable: (new (...args: any[]) => any) | string): SelectBuilder {
    const { table, metadata } = resolveTable(entityOrTable);
    const builder = new SelectBuilder(table);
    if (metadata) {
      builder.columns(...resolveColumns(metadata));
    }
    return builder;
  },

  insert(entityOrTable: (new (...args: any[]) => any) | string): InsertBuilder {
    const { table } = resolveTable(entityOrTable);
    return new InsertBuilder(table);
  },

  update(entityOrTable: (new (...args: any[]) => any) | string): UpdateBuilder {
    const { table } = resolveTable(entityOrTable);
    return new UpdateBuilder(table);
  },

  delete(entityOrTable: (new (...args: any[]) => any) | string): DeleteBuilder {
    const { table } = resolveTable(entityOrTable);
    return new DeleteBuilder(table);
  },
};
