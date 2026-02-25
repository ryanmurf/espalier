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
  PgConnection: () => PgConnection,
  PgDataSource: () => PgDataSource,
  PgPreparedStatement: () => PgPreparedStatement,
  PgResultSet: () => PgResultSet,
  PgStatement: () => PgStatement
});
module.exports = __toCommonJS(index_exports);

// src/pg-data-source.ts
var import_pg = require("pg");
var import_espalier_jdbc3 = require("espalier-jdbc");

// src/pg-connection.ts
var import_espalier_jdbc2 = require("espalier-jdbc");

// src/pg-statement.ts
var import_espalier_jdbc = require("espalier-jdbc");

// src/pg-result-set.ts
var PgResultSet = class {
  constructor(queryResult) {
    this.queryResult = queryResult;
  }
  currentRow = -1;
  getValue(column) {
    const row = this.queryResult.rows[this.currentRow];
    if (!row) return null;
    if (typeof column === "number") {
      const field = this.queryResult.fields[column];
      return field ? row[field.name] : null;
    }
    return row[column];
  }
  async next() {
    this.currentRow++;
    return this.currentRow < this.queryResult.rows.length;
  }
  getString(column) {
    const value = this.getValue(column);
    return value == null ? null : String(value);
  }
  getNumber(column) {
    const value = this.getValue(column);
    return value == null ? null : Number(value);
  }
  getBoolean(column) {
    const value = this.getValue(column);
    return value == null ? null : Boolean(value);
  }
  getDate(column) {
    const value = this.getValue(column);
    if (value == null) return null;
    return value instanceof Date ? value : new Date(value);
  }
  getRow() {
    return this.queryResult.rows[this.currentRow] ?? {};
  }
  getMetadata() {
    return this.queryResult.fields.map((field) => ({
      name: field.name,
      dataType: String(field.dataTypeID),
      nullable: true,
      primaryKey: false
    }));
  }
  async close() {
  }
  [Symbol.asyncIterator]() {
    let index = 0;
    const rows = this.queryResult.rows;
    return {
      async next() {
        if (index < rows.length) {
          return { value: rows[index++], done: false };
        }
        return { value: void 0, done: true };
      }
    };
  }
};

// src/pg-statement.ts
function mapPgErrorCode(err) {
  const code = err.code;
  switch (code) {
    case "23505":
    // unique_violation
    case "23503":
    // foreign_key_violation
    case "23502":
    // not_null_violation
    case "23514":
      return import_espalier_jdbc.DatabaseErrorCode.QUERY_CONSTRAINT;
    case "42601":
    // syntax_error
    case "42P01":
    // undefined_table
    case "42703":
      return import_espalier_jdbc.DatabaseErrorCode.QUERY_SYNTAX;
    default:
      return import_espalier_jdbc.DatabaseErrorCode.QUERY_FAILED;
  }
}
var PgStatement = class {
  constructor(client) {
    this.client = client;
  }
  async executeQuery(sql) {
    try {
      const result = await this.client.query(sql);
      return new PgResultSet(result);
    } catch (err) {
      throw new import_espalier_jdbc.QueryError(
        `Failed to execute query: ${err.message}`,
        sql,
        err,
        mapPgErrorCode(err)
      );
    }
  }
  async executeUpdate(sql) {
    try {
      const result = await this.client.query(sql);
      return result.rowCount ?? 0;
    } catch (err) {
      throw new import_espalier_jdbc.QueryError(
        `Failed to execute update: ${err.message}`,
        sql,
        err,
        mapPgErrorCode(err)
      );
    }
  }
  async close() {
  }
};
var PgPreparedStatement = class extends PgStatement {
  constructor(client, sql) {
    super(client);
    this.sql = sql;
  }
  parameters = /* @__PURE__ */ new Map();
  setParameter(index, value) {
    this.parameters.set(index, value);
  }
  async executeQuery(sql) {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    try {
      const result = await this.client.query(queryText, params);
      return new PgResultSet(result);
    } catch (err) {
      throw new import_espalier_jdbc.QueryError(
        `Failed to execute prepared query: ${err.message}`,
        queryText,
        err,
        mapPgErrorCode(err)
      );
    }
  }
  async executeUpdate(sql) {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    try {
      const result = await this.client.query(queryText, params);
      return result.rowCount ?? 0;
    } catch (err) {
      throw new import_espalier_jdbc.QueryError(
        `Failed to execute prepared update: ${err.message}`,
        queryText,
        err,
        mapPgErrorCode(err)
      );
    }
  }
  collectParameters() {
    const params = [];
    const maxIndex = Math.max(...this.parameters.keys(), 0);
    for (let i = 1; i <= maxIndex; i++) {
      params.push(this.parameters.get(i) ?? null);
    }
    return params;
  }
};

// src/pg-connection.ts
var PgConnection = class {
  constructor(client) {
    this.client = client;
  }
  closed = false;
  createStatement() {
    this.ensureOpen();
    return new PgStatement(this.client);
  }
  prepareStatement(sql) {
    this.ensureOpen();
    return new PgPreparedStatement(this.client, sql);
  }
  async beginTransaction(isolation) {
    this.ensureOpen();
    try {
      await this.client.query("BEGIN");
      if (isolation) {
        await this.client.query(
          `SET TRANSACTION ISOLATION LEVEL ${isolation}`
        );
      }
    } catch (err) {
      throw new import_espalier_jdbc2.TransactionError(
        `Failed to begin transaction: ${err.message}`,
        err,
        import_espalier_jdbc2.DatabaseErrorCode.TX_BEGIN_FAILED
      );
    }
    const client = this.client;
    return {
      async commit() {
        try {
          await client.query("COMMIT");
        } catch (err) {
          throw new import_espalier_jdbc2.TransactionError(
            `Failed to commit: ${err.message}`,
            err,
            import_espalier_jdbc2.DatabaseErrorCode.TX_COMMIT_FAILED
          );
        }
      },
      async rollback() {
        try {
          await client.query("ROLLBACK");
        } catch (err) {
          throw new import_espalier_jdbc2.TransactionError(
            `Failed to rollback: ${err.message}`,
            err,
            import_espalier_jdbc2.DatabaseErrorCode.TX_ROLLBACK_FAILED
          );
        }
      },
      async setSavepoint(name) {
        try {
          await client.query(`SAVEPOINT ${name}`);
        } catch (err) {
          throw new import_espalier_jdbc2.TransactionError(
            `Failed to set savepoint: ${err.message}`,
            err,
            import_espalier_jdbc2.DatabaseErrorCode.TX_SAVEPOINT_FAILED
          );
        }
      },
      async rollbackTo(name) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        } catch (err) {
          throw new import_espalier_jdbc2.TransactionError(
            `Failed to rollback to savepoint: ${err.message}`,
            err,
            import_espalier_jdbc2.DatabaseErrorCode.TX_ROLLBACK_FAILED
          );
        }
      }
    };
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      this.client.release();
    }
  }
  isClosed() {
    return this.closed;
  }
  ensureOpen() {
    if (this.closed) {
      throw new import_espalier_jdbc2.ConnectionError(
        "Connection is closed",
        void 0,
        import_espalier_jdbc2.DatabaseErrorCode.CONNECTION_CLOSED
      );
    }
  }
};

// src/pg-data-source.ts
function mapPoolConfig(config) {
  const pgConfig = { ...config.pg };
  const pool = config.pool;
  if (pool) {
    if (pool.minConnections !== void 0) pgConfig.min = pool.minConnections;
    if (pool.maxConnections !== void 0) pgConfig.max = pool.maxConnections;
    if (pool.acquireTimeout !== void 0) pgConfig.connectionTimeoutMillis = pool.acquireTimeout;
    if (pool.idleTimeout !== void 0) pgConfig.idleTimeoutMillis = pool.idleTimeout;
    if (pool.maxLifetime !== void 0) pgConfig.maxLifetimeSeconds = Math.floor(pool.maxLifetime / 1e3);
  }
  return pgConfig;
}
function isPgDataSourceConfig(config) {
  return typeof config === "object" && config !== null && ("pg" in config || "pool" in config);
}
var PgDataSource = class {
  pool;
  closed = false;
  constructor(config) {
    if (isPgDataSourceConfig(config)) {
      this.pool = new import_pg.Pool(mapPoolConfig(config));
    } else {
      this.pool = new import_pg.Pool(config);
    }
  }
  async getConnection() {
    if (this.closed) {
      throw new import_espalier_jdbc3.ConnectionError(
        "DataSource is closed",
        void 0,
        import_espalier_jdbc3.DatabaseErrorCode.CONNECTION_CLOSED
      );
    }
    try {
      const client = await this.pool.connect();
      return new PgConnection(client);
    } catch (err) {
      const code = err.code === "ETIMEDOUT" ? import_espalier_jdbc3.DatabaseErrorCode.CONNECTION_TIMEOUT : import_espalier_jdbc3.DatabaseErrorCode.CONNECTION_FAILED;
      throw new import_espalier_jdbc3.ConnectionError(
        `Failed to get connection: ${err.message}`,
        err,
        code
      );
    }
  }
  getPoolStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount
    };
  }
  async close(force) {
    if (this.closed) return;
    this.closed = true;
    if (force) {
      await this.pool.end();
    } else {
      await this.pool.end();
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PgConnection,
  PgDataSource,
  PgPreparedStatement,
  PgResultSet,
  PgStatement
});
//# sourceMappingURL=index.cjs.map