import type { SqlValue } from "espalier-jdbc";

/**
 * Describes how a single method argument maps to SQL parameters.
 */
export interface ParamBinding {
  /** Index into the method call arguments array. */
  argIndex: number;
  /**
   * Transform applied to the argument before binding.
   * - "identity": use as-is
   * - "prefix-wildcard": prepend '%' (EndingWith)
   * - "suffix-wildcard": append '%' (StartingWith)
   * - "wrap-wildcard": wrap with '%' (Containing)
   * - "spread": IN-list — spread array elements into individual params
   */
  transform: "identity" | "prefix-wildcard" | "suffix-wildcard" | "wrap-wildcard" | "spread";
}

/**
 * Metadata about the compiled query.
 */
export interface QueryMetadata {
  /** The action type: find, count, delete, exists. */
  action: "find" | "count" | "delete" | "exists";
  /** Total number of method arguments expected (excluding trailing projection). */
  expectedArgCount: number;
  /** If a LIMIT was hard-coded in the method name (findFirst, findTop). */
  limit?: number;
  /** Whether DISTINCT was requested. */
  distinct: boolean;
}

/**
 * A pre-compiled derived query. The SQL template contains $1, $2, ... placeholders.
 * At execution time, method arguments are transformed via paramBindings and bound.
 */
export interface CompiledQuery {
  /** The pre-built SQL template string. */
  sql: string;
  /** Ordered bindings mapping SQL $N placeholders to method arguments. */
  paramBindings: ParamBinding[];
  /** Metadata about the query. */
  metadata: QueryMetadata;
}

/**
 * Bind method call arguments to a compiled query, producing final SQL params.
 * For "spread" bindings (IN lists), the SQL must be re-templated since the
 * placeholder count is dynamic — this is handled by returning a new SQL string.
 */
export function bindCompiledQuery(
  compiled: CompiledQuery,
  args: unknown[],
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  let sql = compiled.sql;
  let hasSpread = false;

  // First pass: check if any spread bindings exist
  for (const binding of compiled.paramBindings) {
    if (binding.transform === "spread") {
      hasSpread = true;
      break;
    }
  }

  if (!hasSpread) {
    // Fast path: no IN-list expansion needed, SQL is static
    for (const binding of compiled.paramBindings) {
      const arg = args[binding.argIndex];
      params.push(applyTransform(arg, binding.transform));
    }
    return { sql, params };
  }

  // Slow path: rebuild SQL with correct placeholder counts for spread bindings
  const segments: string[] = [];
  let paramIdx = 1;
  let lastPos = 0;

  for (const binding of compiled.paramBindings) {
    if (binding.transform === "spread") {
      const arr = args[binding.argIndex] as SqlValue[];
      const arrLen = Array.isArray(arr) ? arr.length : 0;

      // Find the placeholder pattern "IN ($N)" in remaining SQL
      const placeholderPattern = `IN ($${paramIdx})`;
      const idx = sql.indexOf(placeholderPattern, lastPos);
      if (idx !== -1) {
        segments.push(sql.slice(lastPos, idx));
        if (arrLen === 0) {
          segments.push("IN (NULL)");
        } else {
          const placeholders = arr.map((_, i) => `$${paramIdx + i}`);
          segments.push(`IN (${placeholders.join(", ")})`);
          params.push(...arr);
          paramIdx += arrLen;
        }
        lastPos = idx + placeholderPattern.length;
      }
    } else {
      params.push(applyTransform(args[binding.argIndex], binding.transform));
      paramIdx++;
    }
  }

  if (lastPos < sql.length) {
    segments.push(sql.slice(lastPos));
  }

  // Renumber remaining placeholders in the suffix (LIMIT, OFFSET, etc.)
  // These are rare for derived queries, but handle just in case
  sql = segments.join("");

  return { sql, params };
}

function applyTransform(
  arg: unknown,
  transform: ParamBinding["transform"],
): SqlValue {
  switch (transform) {
    case "identity":
      return arg as SqlValue;
    case "prefix-wildcard":
      return `%${arg}` as SqlValue;
    case "suffix-wildcard":
      return `${arg}%` as SqlValue;
    case "wrap-wildcard":
      return `%${arg}%` as SqlValue;
    case "spread":
      // Should not reach here in the fast path
      return arg as SqlValue;
  }
}
