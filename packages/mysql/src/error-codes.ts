import { DatabaseErrorCode } from "espalier-jdbc";

export function mapMysqlErrorCode(err: unknown): DatabaseErrorCode {
  if (err == null) return DatabaseErrorCode.QUERY_FAILED;
  const code = (err as { code?: string }).code;
  const errno = (err as { errno?: number }).errno;

  // mysql2 uses string codes and numeric errno
  switch (code) {
    case "ER_DUP_ENTRY": // 1062
    case "ER_NO_REFERENCED_ROW_2": // 1452
    case "ER_ROW_IS_REFERENCED_2": // 1451
    case "ER_BAD_NULL_ERROR": // 1048
    case "ER_CHECK_CONSTRAINT_VIOLATED": // 3819
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case "ER_PARSE_ERROR": // 1064
    case "ER_NO_SUCH_TABLE": // 1146
    case "ER_BAD_FIELD_ERROR": // 1054
    case "ER_TABLE_EXISTS_ERROR": // 1050
      return DatabaseErrorCode.QUERY_SYNTAX;
    case "ECONNREFUSED":
    case "ENOTFOUND":
      return DatabaseErrorCode.CONNECTION_FAILED;
    case "PROTOCOL_CONNECTION_LOST":
      return DatabaseErrorCode.CONNECTION_CLOSED;
    default:
      break;
  }

  // Fallback on numeric errno
  switch (errno) {
    case 1062:
    case 1452:
    case 1451:
    case 1048:
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case 1064:
    case 1146:
    case 1054:
    case 1050:
      return DatabaseErrorCode.QUERY_SYNTAX;
    default:
      return DatabaseErrorCode.QUERY_FAILED;
  }
}
