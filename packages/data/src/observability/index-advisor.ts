import type { QueryPlan, PlanNode, PlanWarning } from "espalier-jdbc";
import { PlanAdvisor } from "espalier-jdbc";
import type { PlanAdvisorConfig } from "espalier-jdbc";

/**
 * Type of index to suggest.
 */
export type IndexType = "btree" | "hash" | "gin" | "gist";

/**
 * A concrete index suggestion with DDL.
 */
export interface IndexSuggestion {
  /** The table that needs the index. */
  table: string;
  /** Column(s) to index. */
  columns: string[];
  /** Type of index. */
  indexType: IndexType;
  /** Reason the index was suggested. */
  reason: string;
  /** Severity from the underlying PlanWarning. */
  severity: "info" | "warning" | "critical";
  /** Estimated improvement description. */
  estimatedImprovement: string;
  /** Ready-to-run CREATE INDEX DDL statement. */
  ddl: string;
}

/**
 * Configuration for the IndexAdvisor.
 */
export interface IndexAdvisorConfig extends PlanAdvisorConfig {
  /** Minimum estimated rows to trigger an index suggestion. Default: 1000. */
  minRowsForSuggestion?: number;
  /** Known existing indexes to skip (table.column format). */
  existingIndexes?: Set<string>;
}

/**
 * Analyzes query plans and produces concrete index suggestions with DDL.
 *
 * Builds on PlanAdvisor warnings and extracts column-level recommendations
 * from plan nodes (seq scans with filters, sorts, join conditions).
 */
export class IndexAdvisor {
  private readonly planAdvisor: PlanAdvisor;
  private readonly minRows: number;
  private readonly existingIndexes: Set<string>;
  private readonly cachedSuggestions: IndexSuggestion[] = [];

  constructor(config?: IndexAdvisorConfig) {
    this.planAdvisor = new PlanAdvisor(config);
    this.minRows = config?.minRowsForSuggestion ?? 1000;
    this.existingIndexes = config?.existingIndexes ?? new Set();
  }

  /**
   * Analyze a query plan and return index suggestions.
   * Results are accumulated in the cache for later retrieval.
   */
  analyze(plan: QueryPlan): IndexSuggestion[] {
    const suggestions: IndexSuggestion[] = [];
    this.visitNode(plan.rootNode, suggestions);

    // Build set of already-cached suggestion keys for dedup across calls
    const cachedKeys = new Set<string>();
    for (const s of this.cachedSuggestions) {
      cachedKeys.add(`${s.table}.${s.columns.join(",")}`);
    }

    // Deduplicate against existing indexes and previous suggestions
    const deduped = suggestions.filter((s) => {
      const key = `${s.table}.${s.columns.join(",")}`;
      return !this.existingIndexes.has(key) && !cachedKeys.has(key);
    });

    // Deduplicate within this batch
    const seen = new Set<string>();
    const unique: IndexSuggestion[] = [];
    for (const s of deduped) {
      const key = `${s.table}.${s.columns.join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(s);
      }
    }

    this.cachedSuggestions.push(...unique);
    return unique;
  }

  /**
   * Analyze a plan using the underlying PlanAdvisor and return both
   * PlanWarnings and IndexSuggestions.
   */
  analyzeWithWarnings(plan: QueryPlan): {
    warnings: PlanWarning[];
    suggestions: IndexSuggestion[];
  } {
    const warnings = this.planAdvisor.analyze(plan);
    const suggestions = this.analyze(plan);
    return { warnings, suggestions };
  }

  /**
   * Get all accumulated suggestions from previous analyze() calls.
   */
  getSuggestions(): IndexSuggestion[] {
    return [...this.cachedSuggestions];
  }

  /**
   * Clear cached suggestions.
   */
  clearSuggestions(): void {
    this.cachedSuggestions.length = 0;
  }

  /**
   * Mark an index as existing (prevents future suggestions for it).
   */
  addExistingIndex(table: string, columns: string[]): void {
    this.existingIndexes.add(`${table}.${columns.join(",")}`);
  }

  private visitNode(node: PlanNode, suggestions: IndexSuggestion[]): void {
    // Rule 1: Sequential scan with filter — suggest B-tree on filtered column(s)
    if (node.nodeType === "Seq Scan" && node.filter && node.relation) {
      if (node.estimatedRows >= this.minRows) {
        const columns = this.extractColumnsFromFilter(node.filter);
        if (columns.length > 0) {
          suggestions.push(this.createSuggestion(
            node.relation,
            columns,
            "btree",
            "warning",
            `Sequential scan with filter on ${node.relation} (~${node.estimatedRows} rows)`,
            `Avoid sequential scan by indexing filtered columns`,
          ));
        }
      }
    }

    // Rule 2: Sequential scan without filter on large table — suggest index on common query columns
    if (node.nodeType === "Seq Scan" && !node.filter && node.relation) {
      if (node.estimatedRows >= this.minRows * 10) {
        suggestions.push({
          table: node.relation,
          columns: [],
          indexType: "btree",
          severity: "info",
          reason: `Full table scan on ${node.relation} (~${node.estimatedRows} rows)`,
          estimatedImprovement: "Add WHERE clause or index on commonly queried columns",
          ddl: `-- Review queries on "${node.relation}" and add indexes on frequently filtered columns`,
        });
      }
    }

    // Rule 3: Sort operation without index — suggest index on sort columns
    if (node.nodeType === "Sort" && node.sortKey && node.sortKey.length > 0) {
      if (node.estimatedRows >= this.minRows) {
        // Find the parent scan's relation
        const relation = this.findRelationInChildren(node);
        if (relation) {
          const sortColumns = node.sortKey.map((k) => this.cleanColumnName(k));
          if (sortColumns.length > 0 && sortColumns.every((c) => c.length > 0)) {
            suggestions.push(this.createSuggestion(
              relation,
              sortColumns,
              "btree",
              "info",
              `Sort operation on ${node.estimatedRows} rows without index`,
              `Eliminate sort by adding index matching ORDER BY`,
            ));
          }
        }
      }
    }

    // Rule 4: Nested loop with seq scan inner — suggest index on join column
    if (node.nodeType === "Nested Loop" && node.children.length >= 2) {
      const inner = node.children[1];
      if (inner && inner.nodeType === "Seq Scan" && inner.relation && inner.filter) {
        const columns = this.extractColumnsFromFilter(inner.filter);
        if (columns.length > 0) {
          suggestions.push(this.createSuggestion(
            inner.relation,
            columns,
            "btree",
            "warning",
            `Nested loop join with sequential scan on inner relation ${inner.relation}`,
            `Index the join/filter columns to enable index lookup`,
          ));
        }
      }
    }

    // Rule 5: Hash join with large build side — might benefit from index
    if (node.nodeType === "Hash Join" && node.children.length >= 2) {
      const buildSide = node.children[1];
      if (buildSide && buildSide.nodeType === "Seq Scan" && buildSide.relation) {
        if (buildSide.estimatedRows >= this.minRows) {
          const columns = node.filter ? this.extractColumnsFromFilter(node.filter) : [];
          if (columns.length > 0) {
            suggestions.push(this.createSuggestion(
              buildSide.relation,
              columns,
              "btree",
              "info",
              `Hash join build on ${buildSide.relation} (~${buildSide.estimatedRows} rows)`,
              `Index join columns to potentially enable merge join`,
            ));
          }
        }
      }
    }

    for (const child of node.children) {
      this.visitNode(child, suggestions);
    }
  }

  private createSuggestion(
    table: string,
    columns: string[],
    indexType: IndexType,
    severity: "info" | "warning" | "critical",
    reason: string,
    estimatedImprovement: string,
  ): IndexSuggestion {
    const indexName = `idx_${table}_${columns.join("_")}`;
    const colList = columns.map((c) => `"${c}"`).join(", ");
    const usingClause = indexType !== "btree" ? ` USING ${indexType}` : "";
    const ddl = `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}"${usingClause} (${colList});`;

    return { table, columns, indexType, severity, reason, estimatedImprovement, ddl };
  }

  /**
   * Extract column names from a PostgreSQL filter expression.
   * Handles patterns like: (column = $1), (column > $1 AND other_col < $2)
   */
  private extractColumnsFromFilter(filter: string): string[] {
    const columns: string[] = [];
    // Match unquoted identifiers before comparison operators
    const regex = /\b([a-z_][a-z0-9_]*)\s*(?:=|<>|!=|>=?|<=?|~~|LIKE|IN|IS\b)/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = regex.exec(filter)) !== null) {
      const col = match[1].toLowerCase();
      // Skip SQL keywords that might match
      if (!SQL_KEYWORDS.has(col) && !seen.has(col)) {
        seen.add(col);
        columns.push(col);
      }
    }
    return columns;
  }

  /**
   * Clean a sort key expression to extract column name.
   * Handles: "column ASC", "column DESC", "table.column", etc.
   */
  private cleanColumnName(sortKey: string): string {
    // Remove ASC/DESC suffix
    let col = sortKey.replace(/\s+(ASC|DESC|NULLS\s+(?:FIRST|LAST))\s*$/i, "").trim();
    // Remove table prefix
    const dotIdx = col.lastIndexOf(".");
    if (dotIdx >= 0) col = col.slice(dotIdx + 1);
    // Remove quotes
    col = col.replace(/"/g, "");
    return col;
  }

  /**
   * Walk children to find a relation name for context.
   */
  private findRelationInChildren(node: PlanNode): string | undefined {
    if (node.relation) return node.relation;
    for (const child of node.children) {
      const rel = this.findRelationInChildren(child);
      if (rel) return rel;
    }
    return undefined;
  }
}

const SQL_KEYWORDS = new Set([
  "and", "or", "not", "is", "null", "true", "false",
  "in", "between", "like", "ilike", "any", "all",
  "select", "from", "where", "having", "group", "order",
  "limit", "offset", "join", "on", "as", "case", "when",
  "then", "else", "end", "exists", "some", "array",
]);
