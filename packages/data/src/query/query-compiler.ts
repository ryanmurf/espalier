import { quoteIdentifier } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { DerivedQueryDescriptor, PropertyExpression } from "./derived-query-parser.js";
import type { CompiledQuery, ParamBinding, QueryMetadata } from "./compiled-query.js";

/**
 * Resolves a property name to its column name using entity metadata.
 */
function resolveColumn(property: string, metadata: EntityMetadata): string {
  const field = metadata.fields.find(
    (f: FieldMapping) => String(f.fieldName) === property,
  );
  if (field) return field.columnName;

  if (String(metadata.idField) === property) {
    const idMapping = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.idField,
    );
    if (idMapping) return idMapping.columnName;
  }

  throw new Error(
    `Unknown property "${property}" on entity with table "${metadata.tableName}". ` +
      `Known fields: ${metadata.fields.map((f: FieldMapping) => String(f.fieldName)).join(", ")}`,
  );
}

/**
 * Returns the SQL comparison operator and the transform for a given query operator.
 */
function operatorToSql(
  operator: PropertyExpression["operator"],
  column: string,
  paramIdx: number,
): { sql: string; bindings: ParamBinding[]; argCount: number; paramCount: number } {
  const col = quoteIdentifier(column);

  switch (operator) {
    case "Equals":
      return { sql: `${col} = $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "Not":
      return { sql: `${col} <> $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "Like":
      return { sql: `${col} LIKE $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "StartingWith":
      return { sql: `${col} LIKE $${paramIdx}`, bindings: [{ argIndex: -1, transform: "suffix-wildcard" }], argCount: 1, paramCount: 1 };
    case "EndingWith":
      return { sql: `${col} LIKE $${paramIdx}`, bindings: [{ argIndex: -1, transform: "prefix-wildcard" }], argCount: 1, paramCount: 1 };
    case "Containing":
      return { sql: `${col} LIKE $${paramIdx}`, bindings: [{ argIndex: -1, transform: "wrap-wildcard" }], argCount: 1, paramCount: 1 };
    case "GreaterThan":
      return { sql: `${col} > $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "GreaterThanEqual":
      return { sql: `${col} >= $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "LessThan":
      return { sql: `${col} < $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "LessThanEqual":
      return { sql: `${col} <= $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
    case "Between":
      return {
        sql: `${col} BETWEEN $${paramIdx} AND $${paramIdx + 1}`,
        bindings: [
          { argIndex: -1, transform: "identity" },
          { argIndex: -1, transform: "identity" },
        ],
        argCount: 2,
        paramCount: 2,
      };
    case "In":
      return { sql: `${col} IN ($${paramIdx})`, bindings: [{ argIndex: -1, transform: "spread" }], argCount: 1, paramCount: 1 };
    case "NotIn":
      return { sql: `NOT (${col} IN ($${paramIdx}))`, bindings: [{ argIndex: -1, transform: "spread" }], argCount: 1, paramCount: 1 };
    case "IsNull":
      return { sql: `${col} IS NULL`, bindings: [], argCount: 0, paramCount: 0 };
    case "IsNotNull":
      return { sql: `${col} IS NOT NULL`, bindings: [], argCount: 0, paramCount: 0 };
    case "True":
      return { sql: `${col} = TRUE`, bindings: [], argCount: 0, paramCount: 0 };
    case "False":
      return { sql: `${col} = FALSE`, bindings: [], argCount: 0, paramCount: 0 };
    case "SimilarTo":
      return { sql: `${col} <=> $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 1, paramCount: 1 };
  }
}

/**
 * Compiles a parsed DerivedQueryDescriptor and entity metadata into a
 * CompiledQuery that can be executed with just parameter binding.
 */
export class QueryCompiler {
  compile(
    descriptor: DerivedQueryDescriptor,
    metadata: EntityMetadata,
  ): CompiledQuery {
    const bindings: ParamBinding[] = [];
    const whereParts: string[] = [];
    let paramIdx = 1;
    let argIdx = 0;

    // Build WHERE clause in a single pass
    for (const expr of descriptor.properties) {
      const columnName = resolveColumn(expr.property, metadata);
      const result = operatorToSql(expr.operator, columnName, paramIdx);

      whereParts.push(result.sql);

      // Set argIndex on each binding and track arg consumption
      for (const binding of result.bindings) {
        binding.argIndex = argIdx;
        argIdx++;
      }
      // Between consumes 2 args but has 2 bindings, so argIdx is already correct.
      // In/NotIn consumes 1 arg and has 1 binding, also correct.
      // Adjust for operators where argCount differs from binding count:
      // (currently all operators have bindings.length === argCount, but use
      // the explicit argCount to stay correct if that changes)
      if (result.argCount !== result.bindings.length) {
        argIdx = argIdx - result.bindings.length + result.argCount;
      }

      bindings.push(...result.bindings);
      paramIdx += result.paramCount;
    }

    const connector = descriptor.connector === "And" ? " AND " : " OR ";
    const whereClause = whereParts.length > 0 ? whereParts.join(connector) : "";

    const expectedArgCount = argIdx;

    // Build the full SQL
    const sql = this.buildSql(descriptor, metadata, whereClause);

    const queryMetadata: QueryMetadata = {
      action: descriptor.action,
      expectedArgCount,
      distinct: descriptor.distinct,
      ...(descriptor.limit !== undefined ? { limit: descriptor.limit } : {}),
    };

    return {
      sql,
      paramBindings: bindings,
      metadata: queryMetadata,
    };
  }

  private buildSql(
    descriptor: DerivedQueryDescriptor,
    metadata: EntityMetadata,
    whereClause: string,
  ): string {
    const table = quoteIdentifier(metadata.tableName);
    const parts: string[] = [];

    if (descriptor.action === "delete") {
      parts.push(`DELETE FROM ${table}`);
      if (whereClause) parts.push(`WHERE ${whereClause}`);
      return parts.join(" ");
    }

    if (descriptor.action === "count") {
      parts.push(`SELECT COUNT(*) FROM ${table}`);
      if (whereClause) parts.push(`WHERE ${whereClause}`);
      return parts.join(" ");
    }

    if (descriptor.action === "exists") {
      parts.push(`SELECT 1 FROM ${table}`);
      if (whereClause) parts.push(`WHERE ${whereClause}`);
      parts.push("LIMIT 1");
      return parts.join(" ");
    }

    // find action
    const columns = metadata.fields.map((f: FieldMapping) => quoteIdentifier(f.columnName));
    const distinct = descriptor.distinct ? "DISTINCT " : "";
    parts.push(`SELECT ${distinct}${columns.join(", ")} FROM ${table}`);

    if (whereClause) parts.push(`WHERE ${whereClause}`);

    if (descriptor.orderBy) {
      const orderClauses = descriptor.orderBy.map((ob) => {
        const col = resolveColumn(ob.property, metadata);
        return `${quoteIdentifier(col)} ${ob.direction === "Desc" ? "DESC" : "ASC"}`;
      });
      parts.push(`ORDER BY ${orderClauses.join(", ")}`);
    }

    if (descriptor.limit !== undefined) {
      parts.push(`LIMIT ${descriptor.limit}`);
    }

    return parts.join(" ");
  }
}
