import { type SqlValue, quoteIdentifier } from "espalier-jdbc";
import type { Criteria, CriteriaType } from "../query/criteria.js";

export type SearchMode = "plain" | "phrase" | "websearch";

const SEARCH_MODE_FUNCTIONS: Record<SearchMode, string> = {
  plain: "plainto_tsquery",
  phrase: "phraseto_tsquery",
  websearch: "websearch_to_tsquery",
};

/**
 * A Criteria that matches rows where a tsvector column matches a tsquery.
 * Uses parameterized queries — the search term is always a bound parameter.
 */
export class FullTextSearchCriteria implements Criteria {
  readonly type: CriteriaType = "eq"; // reuse "eq" slot for compatibility

  constructor(
    readonly columns: string[],
    readonly language: string,
    readonly searchTerm: string,
    readonly mode: SearchMode = "plain",
    readonly weights?: Record<string, "A" | "B" | "C" | "D">,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const queryFn = SEARCH_MODE_FUNCTIONS[this.mode];

    // Build tsvector expression, optionally with weights
    const tsvectorParts = this.columns.map((col) => {
      const weight = this.weights?.[col];
      const tsvec = `to_tsvector('${this.language}', ${quoteIdentifier(col)})`;
      return weight ? `setweight(${tsvec}, '${weight}')` : tsvec;
    });

    const tsvectorExpr = tsvectorParts.length === 1
      ? tsvectorParts[0]
      : tsvectorParts.join(" || ");

    return {
      sql: `(${tsvectorExpr}) @@ ${queryFn}('${this.language}', $${paramOffset})`,
      params: [this.searchTerm],
    };
  }
}

/**
 * Expression for ts_rank, usable with addRawColumn or ORDER BY.
 */
export class SearchRankExpression {
  constructor(
    readonly columns: string[],
    readonly language: string,
    readonly searchTerm: string,
    readonly mode: SearchMode = "plain",
    readonly weights?: Record<string, "A" | "B" | "C" | "D">,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const queryFn = SEARCH_MODE_FUNCTIONS[this.mode];

    const tsvectorParts = this.columns.map((col) => {
      const weight = this.weights?.[col];
      const tsvec = `to_tsvector('${this.language}', ${quoteIdentifier(col)})`;
      return weight ? `setweight(${tsvec}, '${weight}')` : tsvec;
    });

    const tsvectorExpr = tsvectorParts.length === 1
      ? tsvectorParts[0]
      : tsvectorParts.join(" || ");

    return {
      sql: `ts_rank(${tsvectorExpr}, ${queryFn}('${this.language}', $${paramOffset}))`,
      params: [this.searchTerm],
    };
  }
}

/**
 * Expression for ts_headline, usable with addRawColumn.
 */
export class SearchHighlightExpression {
  constructor(
    readonly column: string,
    readonly language: string,
    readonly searchTerm: string,
    readonly mode: SearchMode = "plain",
    readonly options?: HighlightOptions,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const queryFn = SEARCH_MODE_FUNCTIONS[this.mode];

    let optString = "";
    if (this.options) {
      const parts: string[] = [];
      if (this.options.startTag) parts.push(`StartSel=${this.options.startTag}`);
      if (this.options.stopTag) parts.push(`StopSel=${this.options.stopTag}`);
      if (this.options.maxWords != null) parts.push(`MaxWords=${this.options.maxWords}`);
      if (this.options.minWords != null) parts.push(`MinWords=${this.options.minWords}`);
      if (this.options.maxFragments != null) parts.push(`MaxFragments=${this.options.maxFragments}`);
      if (parts.length > 0) {
        optString = `, '${parts.join(", ")}'`;
      }
    }

    return {
      sql: `ts_headline('${this.language}', ${quoteIdentifier(this.column)}, ${queryFn}('${this.language}', $${paramOffset})${optString})`,
      params: [this.searchTerm],
    };
  }
}

export interface HighlightOptions {
  startTag?: string;
  stopTag?: string;
  maxWords?: number;
  minWords?: number;
  maxFragments?: number;
}

export interface SearchOptions {
  /** Specific fields to search. If omitted, all @Searchable fields are used. */
  fields?: string[];
  /** Override weights per field. */
  weights?: Record<string, "A" | "B" | "C" | "D">;
  /** Text search language. Default: 'english'. */
  language?: string;
  /** Search mode. Default: 'plain'. */
  mode?: SearchMode;
}
