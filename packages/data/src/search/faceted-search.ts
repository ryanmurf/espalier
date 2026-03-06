import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { Criteria } from "../query/criteria.js";
import type { Specification } from "../query/specification.js";
import type { SearchMode } from "./search-criteria.js";
import { FullTextSearchCriteria } from "./search-criteria.js";

/**
 * A specification that performs a full-text search and groups results by a facet field,
 * returning counts per facet value.
 *
 * When applied as a specification, it generates the WHERE clause for the search.
 * Use `toFacetQuery()` to get the full GROUP BY query.
 */
export class FacetedSearchSpecification<T> implements Specification<T> {
  constructor(
    readonly facetField: keyof T & string,
    readonly searchQuery: string,
    readonly searchColumns: string[],
    readonly language: string = "english",
    readonly mode: SearchMode = "plain",
  ) {}

  toPredicate(metadata: EntityMetadata): Criteria {
    const columnNames = this.searchColumns.map((fieldName) => {
      const field = metadata.fields.find((f: FieldMapping) => String(f.fieldName) === fieldName);
      if (field) return field.columnName;
      throw new Error(`Unknown searchable field "${fieldName}" on entity "${metadata.tableName}".`);
    });

    return new FullTextSearchCriteria(columnNames, this.language, this.searchQuery, this.mode);
  }

  /**
   * Build a faceted count query for the given entity metadata.
   * Returns SQL like: SELECT facet_col, COUNT(*) as count FROM table WHERE ... GROUP BY facet_col ORDER BY count DESC
   */
  toFacetQuery(metadata: EntityMetadata): { sql: string; params: SqlValue[] } {
    const facetMapping = metadata.fields.find((f: FieldMapping) => String(f.fieldName) === this.facetField);
    if (!facetMapping) {
      throw new Error(`Unknown facet field "${this.facetField}" on entity "${metadata.tableName}".`);
    }
    const facetColumn = facetMapping.columnName;

    const criteria = this.toPredicate(metadata);
    const whereResult = criteria.toSql(1);

    const sql =
      `SELECT ${quoteIdentifier(facetColumn)} AS "facetValue", COUNT(*) AS "count" ` +
      `FROM ${quoteIdentifier(metadata.tableName)} ` +
      `WHERE ${whereResult.sql} ` +
      `GROUP BY ${quoteIdentifier(facetColumn)} ` +
      `ORDER BY "count" DESC`;

    return { sql, params: whereResult.params };
  }
}

/**
 * Creates a faceted search specification that groups search results by a field.
 *
 * @param facetField - The field to group/facet by
 * @param searchQuery - The search query string
 * @param searchColumns - Column names to search in
 * @param language - Text search language (default: 'english')
 * @param mode - Search mode (default: 'plain')
 */
export function facetedSearch<T>(
  facetField: keyof T & string,
  searchQuery: string,
  searchColumns: string[],
  language?: string,
  mode?: SearchMode,
): FacetedSearchSpecification<T> {
  return new FacetedSearchSpecification<T>(facetField, searchQuery, searchColumns, language, mode);
}
