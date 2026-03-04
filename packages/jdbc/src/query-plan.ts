import type { Connection, SqlValue } from "./index.js";

/**
 * A node in a query execution plan tree.
 */
export interface PlanNode {
  /** The plan node type (e.g., "Seq Scan", "Index Scan", "Hash Join", "Sort"). */
  nodeType: string;
  /** Relation (table) being scanned, if applicable. */
  relation?: string;
  /** Index being used, if applicable. */
  index?: string;
  /** Join type (e.g., "Inner", "Left"), if applicable. */
  joinType?: string;
  /** Sort key, if applicable. */
  sortKey?: string[];
  /** Filter condition applied at this node. */
  filter?: string;

  /** Estimated startup cost. */
  startupCost: number;
  /** Estimated total cost. */
  totalCost: number;
  /** Estimated number of rows. */
  estimatedRows: number;
  /** Estimated average row width in bytes. */
  width: number;

  /** Actual number of rows (only with ANALYZE). */
  actualRows?: number;
  /** Actual startup time in ms (only with ANALYZE). */
  actualStartupTime?: number;
  /** Actual total time in ms (only with ANALYZE). */
  actualTotalTime?: number;
  /** Number of loops executed (only with ANALYZE). */
  loops?: number;

  /** Shared buffers hit (only with ANALYZE + BUFFERS). */
  sharedHit?: number;
  /** Shared buffers read (only with ANALYZE + BUFFERS). */
  sharedRead?: number;
  /** Shared buffers written (only with ANALYZE + BUFFERS). */
  sharedWritten?: number;

  /** Child plan nodes. */
  children: PlanNode[];
}

/**
 * A parsed query execution plan.
 */
export interface QueryPlan {
  /** Root node of the plan tree. */
  rootNode: PlanNode;
  /** Planning time in ms (only with ANALYZE). */
  planningTime?: number;
  /** Execution time in ms (only with ANALYZE). */
  executionTime?: number;
  /** Total estimated cost of the plan. */
  totalCost: number;
}

/**
 * Options for EXPLAIN queries.
 */
export interface ExplainOptions {
  /** Run ANALYZE to get actual execution stats (executes the query). */
  analyze?: boolean;
  /** Include buffer usage statistics (requires analyze). */
  buffers?: boolean;
  /** Include verbose output. */
  verbose?: boolean;
}

/**
 * Analyzes query execution plans.
 */
export interface QueryPlanAnalyzer {
  explain(
    connection: Connection,
    sql: string,
    params?: SqlValue[],
    options?: ExplainOptions,
  ): Promise<QueryPlan>;
}
