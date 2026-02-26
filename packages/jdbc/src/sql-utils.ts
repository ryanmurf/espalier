/**
 * Quote a SQL identifier using double-quote escaping (SQL standard).
 * Works with PostgreSQL, SQLite, and MySQL (in ANSI_QUOTES mode).
 *
 * Handles dotted identifiers (e.g. "schema.table") by quoting each part separately.
 * Special values like "*" and aggregate expressions (e.g. "COUNT(*)") are passed through unquoted.
 *
 * @param name The identifier to quote
 * @returns The quoted identifier
 */
export function quoteIdentifier(name: string): string {
  // Pass through special values that are not identifiers
  if (name === "*" || name === "1" || name === "1 = 0") return name;

  // Pass through aggregate/function expressions like COUNT(*), COALESCE(a, b)
  if (/^[A-Z_]+\s*\(/.test(name)) return name;

  // Handle dotted identifiers (schema.table or table.column)
  if (name.includes(".")) {
    return name
      .split(".")
      .map((part) => quoteIdentifier(part))
      .join(".");
  }

  // Standard SQL double-quote escaping: double any internal quotes
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Convert $1, $2, ... positional params to ? placeholders.
 * Skips single-quoted string literals so that occurrences like 'cost is $1'
 * are left intact.
 *
 * @param sql The SQL string with $N positional parameters
 * @returns The SQL string with $N replaced by ? outside of string literals
 */
export function convertPositionalParams(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      // Inside a single-quoted string literal — copy through, handling '' escapes
      result += "'";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          // Escaped quote
          result += "''";
          i += 2;
        } else if (sql[i] === "'") {
          // End of string literal
          result += "'";
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
    } else if (sql[i] === "$" && i + 1 < sql.length && sql[i + 1] >= "0" && sql[i + 1] <= "9") {
      // $N parameter — replace with ?
      result += "?";
      i++; // skip $
      while (i < sql.length && sql[i] >= "0" && sql[i] <= "9") {
        i++; // skip digits
      }
    } else {
      result += sql[i];
      i++;
    }
  }
  return result;
}

/**
 * Validate that a string is a safe SQL identifier (alphanumeric + underscore, starts with letter or underscore).
 * Throws if the identifier is invalid.
 *
 * @param name The identifier to validate
 * @param label A label for error messages (e.g. "table name", "schema")
 * @returns The validated identifier
 */
export function validateIdentifier(name: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ${label}: "${name}". Must contain only letters, digits, and underscores, and start with a letter or underscore.`,
    );
  }
  return name;
}
