import type { SqlValue } from "espalier-jdbc";
import type { Criteria } from "./criteria.js";
import { LogicalCriteria } from "./criteria.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";

export type JoinType = "INNER" | "LEFT" | "RIGHT";
export type SortDirection = "ASC" | "DESC";

export interface BuiltQuery {
  sql: string;
  params: SqlValue[];
}

interface JoinClause {
  type: JoinType;
  table: string;
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
  private _cacheable = false;
  private _cacheTtlMs: number | undefined;

  constructor(from: string) {
    this._from = from;
  }

  distinct(): SelectBuilder {
    this._distinct = true;
    return this;
  }

  columns(...columns: string[]): SelectBuilder {
    this._columns = columns;
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

  join(type: JoinType, table: string, on: string): SelectBuilder {
    this._joins.push({ type, table, on });
    return this;
  }

  orderBy(column: string, direction: SortDirection = "ASC"): SelectBuilder {
    this._orderBy.push({ column, direction });
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

    parts.push(`SELECT ${this._distinct ? "DISTINCT " : ""}${this._columns.join(", ")}`);
    parts.push(`FROM ${this._from}`);

    for (const join of this._joins) {
      parts.push(`${join.type} JOIN ${join.table} ON ${join.on}`);
    }

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      parts.push(`WHERE ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    if (this._groupBy.length > 0) {
      parts.push(`GROUP BY ${this._groupBy.join(", ")}`);
    }

    if (this._having) {
      const result = this._having.toSql(paramIdx);
      parts.push(`HAVING ${result.sql}`);
      params.push(...result.params);
      paramIdx += result.params.length;
    }

    if (this._orderBy.length > 0) {
      const clauses = this._orderBy.map((o) => `${o.column} ${o.direction}`);
      parts.push(`ORDER BY ${clauses.join(", ")}`);
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
    let sql = `INSERT INTO ${this._table} (${this._columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
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
      return `${s.column} = $${paramIdx++}`;
    });

    let sql = `UPDATE ${this._table} SET ${setClauses.join(", ")}`;

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
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

    let sql = `DELETE FROM ${this._table}`;

    if (this._where) {
      const result = this._where.toSql(paramIdx);
      sql += ` WHERE ${result.sql}`;
      params.push(...result.params);
    }

    if (this._returning.length > 0) {
      sql += ` RETURNING ${this._returning.join(", ")}`;
    }

    return { sql, params };
  }
}

function resolveTable(entityOrTable: (new (...args: any[]) => any) | string): { table: string; metadata?: EntityMetadata } {
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
