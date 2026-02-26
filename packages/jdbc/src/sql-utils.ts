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
