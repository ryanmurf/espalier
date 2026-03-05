/**
 * Enhanced error diagnostics with developer-friendly hints.
 *
 * Wraps common errors with context-aware messages explaining
 * what went wrong, why, and how to fix it.
 */

export interface DiagnosticError {
  originalMessage: string;
  diagnosticMessage: string;
  hint: string;
  entityName?: string;
  fieldName?: string;
  tableName?: string;
  columnName?: string;
}

/**
 * Enhance an error message with diagnostic context.
 * Returns the original error with an improved message.
 */
export function enhanceError(error: Error, context?: ErrorContext): Error {
  const diagnostic = diagnose(error.message, context);
  if (diagnostic) {
    const enhanced = new Error(
      `${diagnostic.diagnosticMessage}\n\n` +
      `  Hint: ${diagnostic.hint}\n`,
    );
    enhanced.name = error.name;
    enhanced.stack = error.stack?.replace(error.message, enhanced.message);
    return enhanced;
  }
  return error;
}

export interface ErrorContext {
  entityName?: string;
  fieldName?: string;
  tableName?: string;
  columnName?: string;
  operation?: string;
}

/**
 * Attempt to diagnose an error message and produce a helpful hint.
 */
export function diagnose(
  message: string,
  context?: ErrorContext,
): DiagnosticError | null {
  const lower = message.toLowerCase();

  // Missing @Table decorator
  if (lower.includes("no @table decorator") || lower.includes("no table decorator")) {
    return {
      originalMessage: message,
      diagnosticMessage: message,
      hint: `Add @Table('${context?.tableName ?? "your_table_name"}') decorator to the ${context?.entityName ?? "entity"} class.`,
      entityName: context?.entityName,
    };
  }

  // Missing @Id decorator
  if (lower.includes("no @id decorator") || lower.includes("no id decorator")) {
    return {
      originalMessage: message,
      diagnosticMessage: message,
      hint: `Add @Id to exactly one field in ${context?.entityName ?? "your entity"}. Every entity needs a primary key field.`,
      entityName: context?.entityName,
    };
  }

  // Connection refused / cannot connect
  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("connect etimedout") ||
    lower.includes("cannot connect")
  ) {
    return {
      originalMessage: message,
      diagnosticMessage: `Could not connect to database.`,
      hint: `Check your connection string and ensure the database server is running. ` +
        `Common causes: wrong host/port, database not started, firewall blocking.`,
    };
  }

  // Table not found / relation does not exist
  if (
    lower.includes("relation") && lower.includes("does not exist") ||
    lower.includes("table") && (lower.includes("doesn't exist") || lower.includes("not found"))
  ) {
    const tableName = extractQuoted(message) ?? context?.tableName;
    return {
      originalMessage: message,
      diagnosticMessage: `Table '${tableName ?? "unknown"}' does not exist.`,
      hint: `Did you run migrations? Use \`espalier migrate up\` to apply pending migrations. ` +
        `Or check that the table name in @Table matches your database schema.`,
      tableName: tableName ?? undefined,
    };
  }

  // Column not found
  if (
    lower.includes("column") && (lower.includes("does not exist") || lower.includes("not found") || lower.includes("unknown column"))
  ) {
    const colName = extractQuoted(message) ?? context?.columnName;
    return {
      originalMessage: message,
      diagnosticMessage: `Column '${colName ?? "unknown"}' not found.`,
      hint: `Check your @Column mapping or run migrations. ` +
        `Ensure the column name in @Column('${colName ?? "name"}') matches the database column.`,
      columnName: colName ?? undefined,
      tableName: context?.tableName,
    };
  }

  // Unique constraint violation
  if (
    lower.includes("unique") && (lower.includes("constraint") || lower.includes("violation") || lower.includes("duplicate"))
  ) {
    return {
      originalMessage: message,
      diagnosticMessage: `Duplicate value for unique constraint.`,
      hint: `A record with this value already exists. ` +
        `${context?.entityName ? `Entity: ${context.entityName}. ` : ""}` +
        `${context?.fieldName ? `Field: ${context.fieldName}. ` : ""}` +
        `Check for duplicate data or use upsert/merge operations.`,
      entityName: context?.entityName,
      fieldName: context?.fieldName,
    };
  }

  // Foreign key violation
  if (
    lower.includes("foreign key") && (lower.includes("constraint") || lower.includes("violation"))
  ) {
    return {
      originalMessage: message,
      diagnosticMessage: `Foreign key constraint violation.`,
      hint: `The referenced record does not exist or you're trying to delete a record ` +
        `that has dependent records. Check cascade settings or create the referenced record first.`,
      entityName: context?.entityName,
    };
  }

  // Permission denied
  if (lower.includes("permission denied") || lower.includes("access denied")) {
    return {
      originalMessage: message,
      diagnosticMessage: `Database access denied.`,
      hint: `The database user doesn't have sufficient permissions. ` +
        `Check your connection credentials and GRANT the necessary privileges.`,
    };
  }

  // Syntax error in SQL
  if (lower.includes("syntax error") && (lower.includes("sql") || lower.includes("at or near"))) {
    return {
      originalMessage: message,
      diagnosticMessage: message,
      hint: `SQL syntax error. If using derived queries, check your method name follows the ` +
        `naming convention (findByFieldName, countByField, etc.). ` +
        `If using raw SQL, verify the query syntax.`,
    };
  }

  // Authentication failed
  if (lower.includes("authentication failed") || lower.includes("password authentication failed")) {
    return {
      originalMessage: message,
      diagnosticMessage: `Database authentication failed.`,
      hint: `Check your database username and password in the connection configuration.`,
    };
  }

  // Database does not exist
  if (lower.includes("database") && lower.includes("does not exist")) {
    const dbName = extractQuoted(message);
    return {
      originalMessage: message,
      diagnosticMessage: `Database '${dbName ?? "unknown"}' does not exist.`,
      hint: `Create the database first: CREATE DATABASE ${dbName ?? "your_database"};`,
    };
  }

  return null;
}

/**
 * Extract a quoted identifier from an error message.
 */
function extractQuoted(message: string): string | null {
  const match = message.match(/"([^"]+)"/);
  return match ? match[1] : null;
}
