import { describe, it, expect } from "vitest";
import {
  DatabaseError,
  ConnectionError,
  QueryError,
  TransactionError,
  IsolationLevel,
} from "../index.js";

// Type-only imports to verify all type exports compile
import type {
  DataSource,
  Connection,
  Statement,
  PreparedStatement,
  ResultSet,
  Transaction,
  SqlValue,
  SqlParameter,
  ColumnMetadata,
} from "../index.js";

describe("espalier-jdbc exports", () => {
  it("exports error classes", () => {
    expect(DatabaseError).toBeDefined();
    expect(ConnectionError).toBeDefined();
    expect(QueryError).toBeDefined();
    expect(TransactionError).toBeDefined();
  });

  it("exports IsolationLevel enum", () => {
    expect(IsolationLevel).toBeDefined();
    expect(IsolationLevel.READ_COMMITTED).toBe("READ COMMITTED");
  });

  it("error classes are constructable", () => {
    expect(new DatabaseError("test")).toBeInstanceOf(Error);
    expect(new ConnectionError("test")).toBeInstanceOf(DatabaseError);
    expect(new QueryError("test")).toBeInstanceOf(DatabaseError);
    expect(new TransactionError("test")).toBeInstanceOf(DatabaseError);
  });

  // Compile-time checks: these type annotations ensure the types are exported.
  // If any type export is missing, this file will fail to compile.
  it("type exports are usable at compile time", () => {
    const sqlValue: SqlValue = "hello";
    const param: SqlParameter = { index: 1, value: sqlValue };
    const meta: ColumnMetadata = {
      name: "id",
      dataType: "integer",
      nullable: false,
      primaryKey: true,
    };

    expect(param.index).toBe(1);
    expect(param.value).toBe("hello");
    expect(meta.name).toBe("id");
  });
});
