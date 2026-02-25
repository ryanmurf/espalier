import type { SqlValue } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { DerivedQueryDescriptor, PropertyExpression } from "./derived-query-parser.js";
import type { BuiltQuery } from "./query-builder.js";
import type { Criteria } from "./criteria.js";
import {
  ComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
} from "./criteria.js";
import { SelectBuilder, DeleteBuilder } from "./query-builder.js";

function resolveColumn(
  property: string,
  metadata: EntityMetadata,
): string {
  const field = metadata.fields.find(
    (f: FieldMapping) => String(f.fieldName) === property,
  );
  if (field) return field.columnName;

  // Also check if the property matches the id field
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

function buildCriteriaForExpression(
  expr: PropertyExpression,
  columnName: string,
  args: unknown[],
  argOffset: number,
): Criteria {
  switch (expr.operator) {
    case "Equals":
      return new ComparisonCriteria("eq", columnName, args[argOffset] as SqlValue);
    case "Not":
      return new ComparisonCriteria("neq", columnName, args[argOffset] as SqlValue);
    case "Like":
      return new ComparisonCriteria("like", columnName, args[argOffset] as SqlValue);
    case "StartingWith":
      return new ComparisonCriteria("like", columnName, `${args[argOffset]}%` as SqlValue);
    case "EndingWith":
      return new ComparisonCriteria("like", columnName, `%${args[argOffset]}` as SqlValue);
    case "Containing":
      return new ComparisonCriteria("like", columnName, `%${args[argOffset]}%` as SqlValue);
    case "GreaterThan":
      return new ComparisonCriteria("gt", columnName, args[argOffset] as SqlValue);
    case "GreaterThanEqual":
      return new ComparisonCriteria("gte", columnName, args[argOffset] as SqlValue);
    case "LessThan":
      return new ComparisonCriteria("lt", columnName, args[argOffset] as SqlValue);
    case "LessThanEqual":
      return new ComparisonCriteria("lte", columnName, args[argOffset] as SqlValue);
    case "Between":
      return new BetweenCriteria(
        columnName,
        args[argOffset] as SqlValue,
        args[argOffset + 1] as SqlValue,
      );
    case "In":
      return new InCriteria(columnName, args[argOffset] as SqlValue[]);
    case "NotIn": {
      // NOT (column IN (...))
      const inCriteria = new InCriteria(columnName, args[argOffset] as SqlValue[]);
      return {
        type: "not",
        toSql(paramOffset: number) {
          const result = inCriteria.toSql(paramOffset);
          return { sql: `NOT (${result.sql})`, params: result.params };
        },
      };
    }
    case "IsNull":
      return new NullCriteria("isNull", columnName);
    case "IsNotNull":
      return new NullCriteria("isNotNull", columnName);
    case "True":
      return new ComparisonCriteria("eq", columnName, true as SqlValue);
    case "False":
      return new ComparisonCriteria("eq", columnName, false as SqlValue);
  }
}

function combineCriteria(
  criteriaList: Criteria[],
  connector: "And" | "Or",
): Criteria {
  if (criteriaList.length === 1) return criteriaList[0];

  const logicalType = connector === "And" ? "and" : "or";
  let combined = criteriaList[0];
  for (let i = 1; i < criteriaList.length; i++) {
    combined = new LogicalCriteria(logicalType as "and" | "or", combined, criteriaList[i]);
  }
  return combined;
}

export function buildDerivedQuery(
  descriptor: DerivedQueryDescriptor,
  metadata: EntityMetadata,
  args: unknown[],
): BuiltQuery {
  // Build criteria from property expressions
  const criteriaList: Criteria[] = [];
  let argOffset = 0;

  for (const expr of descriptor.properties) {
    const columnName = resolveColumn(expr.property, metadata);
    const criteria = buildCriteriaForExpression(expr, columnName, args, argOffset);
    criteriaList.push(criteria);
    argOffset += expr.paramCount;
  }

  const where = combineCriteria(criteriaList, descriptor.connector);

  if (descriptor.action === "delete") {
    const builder = new DeleteBuilder(metadata.tableName).where(where);
    return builder.build();
  }

  if (descriptor.action === "count") {
    const builder = new SelectBuilder(metadata.tableName)
      .columns("COUNT(*)")
      .where(where);
    return builder.build();
  }

  if (descriptor.action === "exists") {
    const builder = new SelectBuilder(metadata.tableName)
      .columns("1")
      .where(where)
      .limit(1);
    return builder.build();
  }

  // find action
  const columns = metadata.fields.map((f: FieldMapping) => f.columnName);

  const builder = new SelectBuilder(metadata.tableName)
    .columns(...columns)
    .where(where);

  if (descriptor.distinct) {
    builder.distinct();
  }

  if (descriptor.orderBy) {
    for (const ob of descriptor.orderBy) {
      const col = resolveColumn(ob.property, metadata);
      builder.orderBy(col, ob.direction === "Desc" ? "DESC" : "ASC");
    }
  }

  if (descriptor.limit !== undefined) {
    builder.limit(descriptor.limit);
  }

  return builder.build();
}
