"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ConnectionError: () => ConnectionError,
  DatabaseError: () => DatabaseError,
  DatabaseErrorCode: () => DatabaseErrorCode,
  IsolationLevel: () => IsolationLevel,
  QueryError: () => QueryError,
  TransactionError: () => TransactionError
});
module.exports = __toCommonJS(index_exports);

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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ConnectionError,
  DatabaseError,
  DatabaseErrorCode,
  IsolationLevel,
  QueryError,
  TransactionError
});
//# sourceMappingURL=index.cjs.map