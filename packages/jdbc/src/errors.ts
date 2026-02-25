export enum DatabaseErrorCode {
  CONNECTION_FAILED = "CONN_FAILED",
  CONNECTION_CLOSED = "CONN_CLOSED",
  CONNECTION_TIMEOUT = "CONN_TIMEOUT",
  QUERY_FAILED = "QUERY_FAILED",
  QUERY_SYNTAX = "QUERY_SYNTAX",
  QUERY_CONSTRAINT = "QUERY_CONSTRAINT",
  TX_BEGIN_FAILED = "TX_BEGIN_FAILED",
  TX_COMMIT_FAILED = "TX_COMMIT_FAILED",
  TX_ROLLBACK_FAILED = "TX_ROLLBACK_FAILED",
  TX_SAVEPOINT_FAILED = "TX_SAVEPOINT_FAILED",
  UNKNOWN = "UNKNOWN",
}

export class DatabaseError extends Error {
  public readonly code: DatabaseErrorCode;

  constructor(
    message: string,
    public readonly cause?: Error,
    code?: DatabaseErrorCode,
  ) {
    super(message);
    this.name = "DatabaseError";
    this.code = code ?? DatabaseErrorCode.UNKNOWN;
  }
}

export class ConnectionError extends DatabaseError {
  constructor(
    message: string,
    cause?: Error,
    code?: DatabaseErrorCode,
  ) {
    super(message, cause, code ?? DatabaseErrorCode.CONNECTION_FAILED);
    this.name = "ConnectionError";
  }
}

export class QueryError extends DatabaseError {
  constructor(
    message: string,
    public readonly sql?: string,
    cause?: Error,
    code?: DatabaseErrorCode,
  ) {
    super(message, cause, code ?? DatabaseErrorCode.QUERY_FAILED);
    this.name = "QueryError";
  }
}

export class TransactionError extends DatabaseError {
  constructor(
    message: string,
    cause?: Error,
    code?: DatabaseErrorCode,
  ) {
    super(message, cause, code ?? DatabaseErrorCode.UNKNOWN);
    this.name = "TransactionError";
  }
}
