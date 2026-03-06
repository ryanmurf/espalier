import type { SqlValue } from "espalier-jdbc";
import { quoteIdentifier } from "espalier-jdbc";
import type { Criteria, VectorMetric } from "../query/criteria.js";
import { VectorDistanceCriteria } from "../query/criteria.js";
import type { OrderByExpressionArg } from "../query/query-builder.js";
import { toVectorLiteral } from "./vector-utils.js";

const vectorOperatorMap: Record<VectorMetric, string> = {
  l2: "<->",
  cosine: "<=>",
  inner_product: "<#>",
};

/**
 * Creates a Criteria that filters by vector similarity distance threshold.
 * Use with SelectBuilder.where() or Specification patterns.
 *
 * @param column - The vector column name
 * @param vector - The query vector (number array)
 * @param threshold - Maximum distance threshold
 * @param metric - Distance metric (default: "cosine")
 * @returns A VectorDistanceCriteria instance
 *
 * @example
 * ```ts
 * const spec = similarTo("embedding", queryVector, 0.5, "cosine");
 * builder.where(spec);
 * ```
 */
export function similarTo(
  column: string,
  vector: number[],
  threshold: number,
  metric: VectorMetric = "cosine",
): Criteria {
  return new VectorDistanceCriteria(column, vector, metric, "lte", threshold);
}

/**
 * Result of nearestTo — contains both the WHERE criteria (optional threshold)
 * and an ORDER BY expression for distance-based sorting.
 */
export interface NearestToResult {
  /** Optional distance threshold criteria (only present if threshold is provided). */
  criteria?: Criteria;
  /** ORDER BY expression for distance ASC ordering. */
  orderBy: OrderByExpressionArg;
  /** The LIMIT to apply for nearest-N queries. */
  limit: number;
}

/**
 * Creates a nearest-neighbor query specification with ordering and limit.
 * Returns both an ORDER BY expression and an optional distance threshold criteria.
 *
 * @param column - The vector column name
 * @param vector - The query vector (number array)
 * @param limit - Maximum number of nearest neighbors to return
 * @param metric - Distance metric (default: "cosine")
 * @param threshold - Optional maximum distance threshold
 * @returns NearestToResult with orderBy expression, limit, and optional criteria
 *
 * @example
 * ```ts
 * const nearest = nearestTo("embedding", queryVector, 10, "cosine");
 * const builder = new SelectBuilder("documents")
 *   .columns("id", "title", "embedding");
 * if (nearest.criteria) builder.where(nearest.criteria);
 * builder.orderByExpression(nearest.orderBy).limit(nearest.limit);
 * ```
 */
export function nearestTo(
  column: string,
  vector: number[],
  limit: number,
  metric: VectorMetric = "cosine",
  threshold?: number,
): NearestToResult {
  const distOp = vectorOperatorMap[metric];
  const vectorLiteral = toVectorLiteral(vector);

  const orderBy: OrderByExpressionArg = {
    direction: "ASC" as const,
    toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
      return {
        sql: `(${quoteIdentifier(column)} ${distOp} $${paramOffset})`,
        params: [vectorLiteral as SqlValue],
      };
    },
  };

  const criteria =
    threshold !== undefined ? new VectorDistanceCriteria(column, vector, metric, "lte", threshold) : undefined;

  return { criteria, orderBy, limit };
}
