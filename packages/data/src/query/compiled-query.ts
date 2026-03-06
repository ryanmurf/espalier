import type { SqlValue } from "espalier-jdbc";
import { toVectorLiteral } from "../vector/vector-utils.js";

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
  transform: "identity" | "prefix-wildcard" | "suffix-wildcard" | "wrap-wildcard" | "spread" | "vector-literal";
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
export function bindCompiledQuery(compiled: CompiledQuery, args: unknown[]): { sql: string; params: SqlValue[] } {
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

  // Slow path: rebuild SQL with correct placeholder counts for spread bindings.
  // The SQL template has sequential placeholders $1, $2, ... (one per binding).
  // We track the original template placeholder index separately from the
  // output parameter index which grows when arrays are spread.
  const segments: string[] = [];
  let templateParamIdx = 1; // placeholder index in the original SQL template
  let outputParamIdx = 1; // placeholder index in the rewritten SQL
  let lastPos = 0;

  for (const binding of compiled.paramBindings) {
    if (binding.transform === "spread") {
      const arr = args[binding.argIndex] as SqlValue[];
      const arrLen = Array.isArray(arr) ? arr.length : 0;

      // Use regex to match exactly "IN ($N)" without matching $N0, $N1, etc.
      const inPattern = new RegExp(`IN \\(\\$${templateParamIdx}\\)`, "g");
      inPattern.lastIndex = lastPos;
      const inMatch = inPattern.exec(sql);
      if (inMatch !== null) {
        const idx = inMatch.index;
        segments.push(sql.slice(lastPos, idx));
        if (arrLen === 0) {
          // Empty IN-list: use unconditional false instead of IN (NULL).
          // col IN (NULL) never matches due to SQL NULL semantics, and
          // the intent of an empty array is "match nothing".
          // The regex matched the full "IN ($N)" token, so we replace
          // the entire match with "(1=0)" — the leading text up to `idx`
          // is already in segments from the slice above.
          segments.push("(1=0)");
        } else {
          const placeholders = arr.map((_, i) => `$${outputParamIdx + i}`);
          segments.push(`IN (${placeholders.join(", ")})`);
          params.push(...arr);
          outputParamIdx += arrLen;
        }
        lastPos = idx + inMatch[0].length;
      }
    } else {
      // Use regex to match exactly $N without matching $N0, $N1, etc.
      const paramPattern = new RegExp(`\\$${templateParamIdx}(?!\\d)`, "g");
      paramPattern.lastIndex = lastPos;
      const paramMatch = paramPattern.exec(sql);
      if (paramMatch !== null) {
        const idx = paramMatch.index;
        segments.push(sql.slice(lastPos, idx));
        segments.push(`$${outputParamIdx}`);
        lastPos = idx + paramMatch[0].length;
      }
      params.push(applyTransform(args[binding.argIndex], binding.transform));
      outputParamIdx++;
    }
    templateParamIdx++;
  }

  if (lastPos < sql.length) {
    segments.push(sql.slice(lastPos));
  }

  sql = segments.join("");

  return { sql, params };
}

/**
 * Escape LIKE metacharacters in a user-supplied value.
 * Prevents wildcard injection by escaping %, _, and \.
 */
function escapeLikeValue(value: unknown): string {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function applyTransform(arg: unknown, transform: ParamBinding["transform"]): SqlValue {
  switch (transform) {
    case "identity":
      return arg as SqlValue;
    case "prefix-wildcard":
      return `%${escapeLikeValue(arg)}` as SqlValue;
    case "suffix-wildcard":
      return `${escapeLikeValue(arg)}%` as SqlValue;
    case "wrap-wildcard":
      return `%${escapeLikeValue(arg)}%` as SqlValue;
    case "spread":
      // Should not reach here in the fast path
      return arg as SqlValue;
    case "vector-literal": {
      // Convert number[] to pgvector string format '[0.1,0.2,...]'
      const vec = arg as number[];
      return toVectorLiteral(vec) as SqlValue;
    }
    default: {
      const _exhaustive: never = transform;
      throw new Error(`Unknown transform: ${_exhaustive}`);
    }
  }
}
