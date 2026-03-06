import { quoteIdentifier, type SqlValue } from "espalier-jdbc";
import type { Criteria, CriteriaType } from "../query/criteria.js";

export type SearchMode = "plain" | "phrase" | "websearch";

/** Validate and sanitize a PG text search language identifier. */
function sanitizeLanguage(lang: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(lang)) {
    throw new Error(`Invalid search language: "${lang}". Must be a valid identifier.`);
  }
  return lang;
}

/** Sanitize ts_headline tag options — only allow simple HTML-like tags. */
function sanitizeTag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9<>/=" ]/g, "");
}

const VALID_WEIGHTS = new Set(["A", "B", "C", "D"]);

/** Validate a tsvector weight letter at runtime. */
function validateWeight(weight: string, col: string): void {
  if (!VALID_WEIGHTS.has(weight)) {
    throw new Error(`Invalid search weight "${weight}" for column "${col}". Must be A, B, C, or D.`);
  }
}

const SEARCH_MODE_FUNCTIONS: Record<SearchMode, string> = {
  plain: "plainto_tsquery",
  phrase: "phraseto_tsquery",
  websearch: "websearch_to_tsquery",
};

/** Validate search mode at runtime. */
function validateMode(mode: string): string {
  const fn = SEARCH_MODE_FUNCTIONS[mode as SearchMode];
  if (!fn) {
    throw new Error(`Invalid search mode: "${mode}". Must be "plain", "phrase", or "websearch".`);
  }
  return fn;
}

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
    const queryFn = validateMode(this.mode);
    const lang = sanitizeLanguage(this.language);

    const tsvectorParts = this.columns.map((col) => {
      const weight = this.weights?.[col];
      const tsvec = `to_tsvector('${lang}', ${quoteIdentifier(col)})`;
      if (weight) {
        validateWeight(weight, col);
        return `setweight(${tsvec}, '${weight}')`;
      }
      return tsvec;
    });

    const tsvectorExpr = tsvectorParts.length === 1 ? tsvectorParts[0] : tsvectorParts.join(" || ");

    return {
      sql: `(${tsvectorExpr}) @@ ${queryFn}('${lang}', $${paramOffset})`,
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
    const queryFn = validateMode(this.mode);
    const lang = sanitizeLanguage(this.language);

    const tsvectorParts = this.columns.map((col) => {
      const weight = this.weights?.[col];
      const tsvec = `to_tsvector('${lang}', ${quoteIdentifier(col)})`;
      if (weight) {
        validateWeight(weight, col);
        return `setweight(${tsvec}, '${weight}')`;
      }
      return tsvec;
    });

    const tsvectorExpr = tsvectorParts.length === 1 ? tsvectorParts[0] : tsvectorParts.join(" || ");

    return {
      sql: `ts_rank(${tsvectorExpr}, ${queryFn}('${lang}', $${paramOffset}))`,
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
    const queryFn = validateMode(this.mode);
    const lang = sanitizeLanguage(this.language);

    let optString = "";
    if (this.options) {
      const parts: string[] = [];
      if (this.options.startTag) parts.push(`StartSel=${sanitizeTag(this.options.startTag)}`);
      if (this.options.stopTag) parts.push(`StopSel=${sanitizeTag(this.options.stopTag)}`);
      if (this.options.maxWords != null) {
        const n = Math.floor(Number(this.options.maxWords));
        if (Number.isFinite(n) && n > 0) parts.push(`MaxWords=${n}`);
      }
      if (this.options.minWords != null) {
        const n = Math.floor(Number(this.options.minWords));
        if (Number.isFinite(n) && n > 0) parts.push(`MinWords=${n}`);
      }
      if (this.options.maxFragments != null) {
        const n = Math.floor(Number(this.options.maxFragments));
        if (Number.isFinite(n) && n >= 0) parts.push(`MaxFragments=${n}`);
      }
      if (parts.length > 0) {
        optString = `, '${parts.join(", ")}'`;
      }
    }

    return {
      sql: `ts_headline('${lang}', ${quoteIdentifier(this.column)}, ${queryFn}('${lang}', $${paramOffset})${optString})`,
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
