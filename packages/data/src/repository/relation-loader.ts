import { quoteIdentifier } from "espalier-jdbc";
import type { SqlValue, Connection } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { SelectBuilder } from "../query/query-builder.js";
import { ComparisonCriteria, InCriteria, RawInCriteria } from "../query/criteria.js";
import type { ManyToOneRelation, OneToOneRelation, OneToManyRelation, ManyToManyRelation } from "../decorators/relations.js";
import { createRowMapper } from "../mapping/row-mapper.js";
import { getIdField } from "../decorators/id.js";
import { getColumnMappings } from "../decorators/column.js";

/**
 * Separator used in column aliases to disambiguate joined table columns.
 * e.g. "department"."name" -> "department__name"
 */
const ALIAS_SEP = "__";

interface JoinSpec {
  relation: ManyToOneRelation | OneToOneRelation;
  targetMetadata: EntityMetadata;
  alias: string;
}

/**
 * Collects single-valued relations (ManyToOne, OneToOne owner-side) that
 * have fetchStrategy === "JOIN".
 */
export function getJoinFetchSpecs(metadata: EntityMetadata): JoinSpec[] {
  const specs: JoinSpec[] = [];
  let aliasIdx = 0;

  for (const relation of metadata.manyToOneRelations) {
    if (relation.fetchStrategy !== "JOIN" || relation.lazy) continue;
    const targetClass = relation.target();
    const targetMetadata = getEntityMetadata(targetClass);
    specs.push({
      relation,
      targetMetadata,
      alias: `j${aliasIdx++}`,
    });
  }

  for (const relation of metadata.oneToOneRelations) {
    if (relation.fetchStrategy !== "JOIN" || relation.lazy) continue;
    if (!relation.isOwning || !relation.joinColumn) continue;
    const targetClass = relation.target();
    const targetMetadata = getEntityMetadata(targetClass);
    specs.push({
      relation,
      targetMetadata,
      alias: `j${aliasIdx++}`,
    });
  }

  return specs;
}

/**
 * Builds column expressions for a SELECT with JOINs.
 * Parent columns: "parent_table"."col" AS "parent_table__col"
 * Joined columns: "alias"."col" AS "alias__col"
 */
export function buildJoinColumns(
  parentTable: string,
  parentFields: FieldMapping[],
  joinSpecs: JoinSpec[],
): string[] {
  const cols: string[] = [];

  // Parent entity columns
  for (const field of parentFields) {
    cols.push(
      `${quoteIdentifier(parentTable)}.${quoteIdentifier(field.columnName)} AS ${quoteIdentifier(parentTable + ALIAS_SEP + field.columnName)}`,
    );
  }

  // Joined relation columns
  for (const spec of joinSpecs) {
    for (const field of spec.targetMetadata.fields) {
      cols.push(
        `${quoteIdentifier(spec.alias)}.${quoteIdentifier(field.columnName)} AS ${quoteIdentifier(spec.alias + ALIAS_SEP + field.columnName)}`,
      );
    }
  }

  return cols;
}

/**
 * Adds LEFT JOINs to a SelectBuilder for single-valued relations.
 */
export function addJoins(
  builder: SelectBuilder,
  parentTable: string,
  joinSpecs: JoinSpec[],
): void {
  for (const spec of joinSpecs) {
    const relation = spec.relation;
    let joinColumn: string;
    let targetPkColumn: string;

    if ("joinColumn" in relation && relation.joinColumn) {
      // ManyToOne or OneToOne owner-side: FK is on parent table
      joinColumn = relation.joinColumn;
      const targetIdField = spec.targetMetadata.idField;
      const idMapping = spec.targetMetadata.fields.find(
        (f) => f.fieldName === targetIdField,
      );
      targetPkColumn = idMapping ? idMapping.columnName : String(targetIdField);
    } else {
      continue;
    }

    const onClause =
      `${quoteIdentifier(parentTable)}.${quoteIdentifier(joinColumn)} = ${quoteIdentifier(spec.alias)}.${quoteIdentifier(targetPkColumn)}`;

    builder.join("LEFT", spec.targetMetadata.tableName, onClause, spec.alias);
  }
}

/**
 * Extracts entity data from a JOIN result row.
 * Row keys are like "parent_table__col" and "alias__col".
 */
export function extractParentRow(
  row: Record<string, unknown>,
  parentTable: string,
  parentFields: FieldMapping[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of parentFields) {
    result[field.columnName] = row[parentTable + ALIAS_SEP + field.columnName];
  }
  return result;
}

/**
 * Extracts a related entity's data from a JOIN result row.
 * Returns null if the PK column is null (LEFT JOIN produced no match).
 */
export function extractRelatedRow(
  row: Record<string, unknown>,
  spec: JoinSpec,
): Record<string, unknown> | null {
  const idField = spec.targetMetadata.idField;
  const idMapping = spec.targetMetadata.fields.find(
    (f) => f.fieldName === idField,
  );
  const idColumnName = idMapping ? idMapping.columnName : String(idField);
  const pkValue = row[spec.alias + ALIAS_SEP + idColumnName];

  // If PK is null, the LEFT JOIN didn't match any row
  if (pkValue === null || pkValue === undefined) return null;

  const result: Record<string, unknown> = {};
  for (const field of spec.targetMetadata.fields) {
    result[field.columnName] = row[spec.alias + ALIAS_SEP + field.columnName];
  }
  return result;
}

/**
 * BATCH fetch: loads children for a set of parent IDs using IN queries in chunks.
 * For @OneToMany: SELECT * FROM children WHERE fk_column IN (...)
 * For @ManyToMany: SELECT t.* FROM target t JOIN join_table jt ON ... WHERE jt.join_col IN (...)
 */
export async function batchLoadOneToMany(
  conn: Connection,
  parentIds: SqlValue[],
  relation: OneToManyRelation,
  parentMetadata: EntityMetadata,
): Promise<Map<unknown, unknown[]>> {
  const targetClass = relation.target();
  const targetMetadata = getEntityMetadata(targetClass);
  const targetMapper = createRowMapper(targetClass, targetMetadata);
  const result = new Map<unknown, unknown[]>();

  // Find the FK column on the target entity that references the parent
  const targetManyToOnes = targetMetadata.manyToOneRelations;
  const owningRelation = targetManyToOnes.find(
    (r) => String(r.fieldName) === relation.mappedBy,
  );
  if (!owningRelation) return result;
  const fkColumn = owningRelation.joinColumn;

  const batchSize = relation.batchSize;
  for (let i = 0; i < parentIds.length; i += batchSize) {
    const batch = parentIds.slice(i, i + batchSize);
    const builder = new SelectBuilder(targetMetadata.tableName)
      .columns(...targetMetadata.fields.map((f) => f.columnName));
    builder.where(new InCriteria(fkColumn, batch));

    const query = builder.build();
    const stmt = conn.prepareStatement(query.sql);
    try {
      for (let p = 0; p < query.params.length; p++) {
        stmt.setParameter(p + 1, query.params[p]);
      }
      const rs = await stmt.executeQuery();
      while (await rs.next()) {
        const row = rs.getRow();
        const fkValue = row[fkColumn];
        const entity = targetMapper.mapRow(rs);
        if (!result.has(fkValue)) result.set(fkValue, []);
        result.get(fkValue)!.push(entity);
      }
    } finally {
      await stmt.close().catch(() => {});
    }
  }

  return result;
}

export async function batchLoadManyToMany(
  conn: Connection,
  parentIds: SqlValue[],
  relation: ManyToManyRelation,
): Promise<Map<unknown, unknown[]>> {
  const result = new Map<unknown, unknown[]>();
  if (!relation.isOwning || !relation.joinTable) return result;

  const targetClass = relation.target();
  const targetMetadata = getEntityMetadata(targetClass);
  const targetMapper = createRowMapper(targetClass, targetMetadata);

  const jt = relation.joinTable;
  const targetIdField = targetMetadata.idField;
  const targetIdMapping = targetMetadata.fields.find((f) => f.fieldName === targetIdField);
  const targetPkColumn = targetIdMapping ? targetIdMapping.columnName : String(targetIdField);

  const batchSize = relation.batchSize;
  for (let i = 0; i < parentIds.length; i += batchSize) {
    const batch = parentIds.slice(i, i + batchSize);

    // SELECT target.*, "jt"."join_col" AS "__jt_fk"
    // FROM target
    // INNER JOIN join_table "jt" ON target.pk = "jt".inverse_col
    // WHERE "jt"."join_col" IN (...)
    const tbl = targetMetadata.tableName;
    const cols = targetMetadata.fields.map(
      (f) => `${quoteIdentifier(tbl)}.${quoteIdentifier(f.columnName)}`,
    );
    cols.push(`${quoteIdentifier("jt")}.${quoteIdentifier(jt.joinColumn)} AS ${quoteIdentifier("__jt_fk")}`);

    const builder = new SelectBuilder(tbl);
    builder.rawColumns(...cols);
    builder.join(
      "INNER",
      jt.name,
      `${quoteIdentifier(tbl)}.${quoteIdentifier(targetPkColumn)} = ${quoteIdentifier("jt")}.${quoteIdentifier(jt.inverseJoinColumn)}`,
      "jt",
    );
    const whereExpr = `${quoteIdentifier("jt")}.${quoteIdentifier(jt.joinColumn)}`;
    builder.where(new RawInCriteria(whereExpr, batch));

    const query = builder.build();
    const stmt = conn.prepareStatement(query.sql);
    try {
      for (let p = 0; p < query.params.length; p++) {
        stmt.setParameter(p + 1, query.params[p]);
      }
      const rs = await stmt.executeQuery();
      while (await rs.next()) {
        const row = rs.getRow();
        const parentFk = row["__jt_fk"];
        const targetRow: Record<string, unknown> = {};
        for (const f of targetMetadata.fields) {
          targetRow[f.columnName] = row[f.columnName];
        }
        const mockRs = {
          getRow: () => targetRow,
          next: async () => false,
          getString: () => null,
          getNumber: () => null,
          getBoolean: () => null,
          getDate: () => null,
          getMetadata: () => [],
          close: async () => {},
          [Symbol.asyncIterator]: () => ({
            async next() { return { value: undefined as any, done: true as const }; },
          }),
        };
        const entity = targetMapper.mapRow(mockRs);
        if (!result.has(parentFk)) result.set(parentFk, []);
        result.get(parentFk)!.push(entity);
      }
    } finally {
      await stmt.close().catch(() => {});
    }
  }

  return result;
}

export { type JoinSpec };
