/**
 * Type-safe raw SQL via tagged template literals.
 *
 * @example
 * ```ts
 * const query = sql`SELECT * FROM users WHERE id = ${userId}`;
 * // query.text === "SELECT * FROM users WHERE id = $1"
 * // query.params === [userId]
 * ```
 */

/**
 * A compiled SQL query with parameter bindings and optional type brand.
 */
export interface TypedQuery<T = unknown> {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly _type?: T;
}

/**
 * A SQL fragment that can be embedded in other `sql` tagged templates.
 * Produced by calling `sql` as a tagged template.
 */
const SQL_FRAGMENT_BRAND = Symbol("SqlFragment");

interface SqlFragment {
  readonly [SQL_FRAGMENT_BRAND]: true;
  readonly text: string;
  readonly params: readonly unknown[];
}

function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    SQL_FRAGMENT_BRAND in value &&
    (value as Record<symbol, unknown>)[SQL_FRAGMENT_BRAND] === true
  );
}

/**
 * Tagged template literal for building parameterized SQL queries.
 *
 * Features:
 * - Interpolated values become positional parameters ($1, $2, ...)
 * - Arrays are expanded for IN clauses: `WHERE id IN (${ids})`
 * - Nested `sql` fragments are composed inline (their params are merged)
 * - `null` and `undefined` are passed as params directly
 *
 * @example
 * ```ts
 * const id = 42;
 * const query = sql`SELECT * FROM users WHERE id = ${id}`;
 * // { text: "SELECT * FROM users WHERE id = $1", params: [42] }
 *
 * const ids = [1, 2, 3];
 * const query2 = sql`SELECT * FROM users WHERE id IN (${ids})`;
 * // { text: "SELECT * FROM users WHERE id IN ($1, $2, $3)", params: [1, 2, 3] }
 *
 * const where = sql`name = ${"Alice"}`;
 * const composed = sql`SELECT * FROM users WHERE ${where}`;
 * // { text: "SELECT * FROM users WHERE name = $1", params: ["Alice"] }
 * ```
 */
export function sql<T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): TypedQuery<T> {
  const textParts: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    textParts.push(strings[i]);

    if (i < values.length) {
      const value = values[i];

      if (isSqlFragment(value)) {
        // Nested sql fragment: inline text and remap param indices
        const remapped = remapParams(value.text, params.length);
        textParts.push(remapped);
        params.push(...value.params);
      } else if (Array.isArray(value)) {
        // Array expansion for IN clauses
        if (value.length === 0) {
          // Empty IN clause — use impossible condition
          textParts.push("SELECT 1 WHERE FALSE");
        } else {
          const placeholders: string[] = [];
          for (const item of value) {
            params.push(item);
            placeholders.push(`$${params.length}`);
          }
          textParts.push(placeholders.join(", "));
        }
      } else {
        // Scalar value
        params.push(value);
        textParts.push(`$${params.length}`);
      }
    }
  }

  const result: TypedQuery<T> & SqlFragment = {
    text: textParts.join(""),
    params,
    [SQL_FRAGMENT_BRAND]: true,
  };

  return result;
}

/**
 * Remap $N placeholders in a fragment's text to account for params already
 * in the parent query.
 */
function remapParams(text: string, offset: number): string {
  if (offset === 0) return text;
  return text.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}
