// src/transaction.ts
var IsolationLevel = /* @__PURE__ */ ((IsolationLevel2) => {
  IsolationLevel2["READ_UNCOMMITTED"] = "READ UNCOMMITTED";
  IsolationLevel2["READ_COMMITTED"] = "READ COMMITTED";
  IsolationLevel2["REPEATABLE_READ"] = "REPEATABLE READ";
  IsolationLevel2["SERIALIZABLE"] = "SERIALIZABLE";
  return IsolationLevel2;
})(IsolationLevel || {});

// src/errors.ts
var DatabaseErrorCode = /* @__PURE__ */ ((DatabaseErrorCode2) => {
  DatabaseErrorCode2["CONNECTION_FAILED"] = "CONN_FAILED";
  DatabaseErrorCode2["CONNECTION_CLOSED"] = "CONN_CLOSED";
  DatabaseErrorCode2["CONNECTION_TIMEOUT"] = "CONN_TIMEOUT";
  DatabaseErrorCode2["QUERY_FAILED"] = "QUERY_FAILED";
  DatabaseErrorCode2["QUERY_SYNTAX"] = "QUERY_SYNTAX";
  DatabaseErrorCode2["QUERY_CONSTRAINT"] = "QUERY_CONSTRAINT";
  DatabaseErrorCode2["TX_BEGIN_FAILED"] = "TX_BEGIN_FAILED";
  DatabaseErrorCode2["TX_COMMIT_FAILED"] = "TX_COMMIT_FAILED";
  DatabaseErrorCode2["TX_ROLLBACK_FAILED"] = "TX_ROLLBACK_FAILED";
  DatabaseErrorCode2["TX_SAVEPOINT_FAILED"] = "TX_SAVEPOINT_FAILED";
  DatabaseErrorCode2["UNKNOWN"] = "UNKNOWN";
  return DatabaseErrorCode2;
})(DatabaseErrorCode || {});
var DatabaseError = class extends Error {
  constructor(message, cause, code) {
    super(message);
    this.cause = cause;
    this.name = "DatabaseError";
    this.code = code ?? "UNKNOWN" /* UNKNOWN */;
  }
  code;
};
var ConnectionError = class extends DatabaseError {
  constructor(message, cause, code) {
    super(message, cause, code ?? "CONN_FAILED" /* CONNECTION_FAILED */);
    this.name = "ConnectionError";
  }
};
var QueryError = class extends DatabaseError {
  constructor(message, sql, cause, code) {
    super(message, cause, code ?? "QUERY_FAILED" /* QUERY_FAILED */);
    this.sql = sql;
    this.name = "QueryError";
  }
};
var TransactionError = class extends DatabaseError {
  constructor(message, cause, code) {
    super(message, cause, code ?? "UNKNOWN" /* UNKNOWN */);
    this.name = "TransactionError";
  }
};
export {
  ConnectionError,
  DatabaseError,
  DatabaseErrorCode,
  IsolationLevel,
  QueryError,
  TransactionError
};
//# sourceMappingURL=index.js.map