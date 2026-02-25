import { DatabaseErrorCode } from "espalier-jdbc";

export function mapSqliteErrorCode(err: unknown): DatabaseErrorCode {
  const code = (err as { code?: string }).code;

  switch (code) {
    case "SQLITE_CONSTRAINT":
    case "SQLITE_CONSTRAINT_UNIQUE":
    case "SQLITE_CONSTRAINT_PRIMARYKEY":
    case "SQLITE_CONSTRAINT_FOREIGNKEY":
    case "SQLITE_CONSTRAINT_NOTNULL":
    case "SQLITE_CONSTRAINT_CHECK":
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case "SQLITE_ERROR":
      return DatabaseErrorCode.QUERY_SYNTAX;
    case "SQLITE_BUSY":
    case "SQLITE_LOCKED":
      return DatabaseErrorCode.CONNECTION_FAILED;
    case "SQLITE_NOTFOUND":
    case "SQLITE_CANTOPEN":
      return DatabaseErrorCode.CONNECTION_FAILED;
    default:
      return DatabaseErrorCode.QUERY_FAILED;
  }
}
