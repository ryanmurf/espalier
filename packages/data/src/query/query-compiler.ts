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
      return { sql: `${col} = $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 0, paramCount: 1 };
    case "False":
      return { sql: `${col} = $${paramIdx}`, bindings: [{ argIndex: -1, transform: "identity" }], argCount: 0, paramCount: 1 };
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
    const allBindings: ParamBinding[] = [];
    const whereParts: string[] = [];
    let paramIdx = 1;
    let argIdx = 0;

    // Build WHERE clause
    for (const expr of descriptor.properties) {
      const columnName = resolveColumn(expr.property, metadata);
      const result = operatorToSql(expr.operator, columnName, paramIdx);

      // Set argIndex on each binding
      for (const binding of result.bindings) {
        if (expr.operator === "True") {
          // True/False don't consume method args — they use static values
          // We'll handle this by not incrementing argIdx but pushing static params
        } else if (expr.operator === "False") {
          // Same as True
        } else {
          binding.argIndex = argIdx;
          argIdx += (binding.transform === "spread" ? 1 : 1);
        }
      }

      // For True/False, the bindings have static values, not arg bindings
      if (expr.operator === "True" || expr.operator === "False") {
        // These are zero-arg operators with a static param
        // We handle them specially: no param binding, embed in SQL directly
        const col = quoteIdentifier(columnName);
        const val = expr.operator === "True" ? "TRUE" : "FALSE";
        whereParts.push(`${col} = ${val}`);
      } else {
        whereParts.push(result.sql);
        allBindings.push(...result.bindings);
        paramIdx += result.paramCount;
      }
    }

    // Fix argIdx tracking for Between (2 args from 1 property)
    // Re-walk to properly set argIndex
    const correctedBindings: ParamBinding[] = [];
    let correctedArgIdx = 0;
    let bindingIdx = 0;
    for (const expr of descriptor.properties) {
      if (expr.operator === "True" || expr.operator === "False") continue;
      const paramCount = expr.paramCount;
      for (let p = 0; p < paramCount; p++) {
        if (bindingIdx < allBindings.length) {
          correctedBindings.push({
            ...allBindings[bindingIdx],
            argIndex: correctedArgIdx + p,
          });
          bindingIdx++;
        }
      }
      // For spread (In/NotIn), only 1 binding but 1 arg
      if (paramCount === 0 && bindingIdx < allBindings.length) {
        // IsNull/IsNotNull have 0 params and 0 bindings
      }
      correctedArgIdx += paramCount;
    }

    const connector = descriptor.connector === "And" ? " AND " : " OR ";
    const whereClause = whereParts.length > 0 ? whereParts.join(connector) : "";

    const expectedArgCount = correctedArgIdx;

    // Build the full SQL
    const sql = this.buildSql(descriptor, metadata, whereClause, paramIdx, correctedBindings);

    const queryMetadata: QueryMetadata = {
      action: descriptor.action,
      expectedArgCount,
      distinct: descriptor.distinct,
      ...(descriptor.limit !== undefined ? { limit: descriptor.limit } : {}),
    };

    return {
      sql,
      paramBindings: correctedBindings,
      metadata: queryMetadata,
    };
  }

  private buildSql(
    descriptor: DerivedQueryDescriptor,
    metadata: EntityMetadata,
    whereClause: string,
    nextParamIdx: number,
    bindings: ParamBinding[],
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
      parts.push(`LIMIT $${nextParamIdx}`);
      // Add a static limit binding (value 1) - but we'll handle this differently
      // Actually, for exists we can hardcode LIMIT 1 directly
      // Remove the parameterized LIMIT and use literal
      parts.pop();
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
