import { describe, it, expect } from "vitest";
import { DatabaseErrorCode } from "espalier-jdbc";
import { mapSqliteErrorCode } from "../error-codes.js";

describe("mapSqliteErrorCode", () => {
  it("maps SQLITE_CONSTRAINT to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("constraint"), {
      code: "SQLITE_CONSTRAINT",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_CONSTRAINT_UNIQUE to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("unique"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_CONSTRAINT_PRIMARYKEY to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("pk"), {
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_CONSTRAINT_FOREIGNKEY to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("fk"), {
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_CONSTRAINT_NOTNULL to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("not null"), {
      code: "SQLITE_CONSTRAINT_NOTNULL",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_CONSTRAINT_CHECK to QUERY_CONSTRAINT", () => {
    const err = Object.assign(new Error("check"), {
      code: "SQLITE_CONSTRAINT_CHECK",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("maps SQLITE_ERROR to QUERY_SYNTAX", () => {
    const err = Object.assign(new Error("syntax"), {
      code: "SQLITE_ERROR",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_SYNTAX);
  });

  it("maps SQLITE_BUSY to CONNECTION_FAILED", () => {
    const err = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("maps SQLITE_LOCKED to CONNECTION_FAILED", () => {
    const err = Object.assign(new Error("locked"), {
      code: "SQLITE_LOCKED",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("maps SQLITE_CANTOPEN to CONNECTION_FAILED", () => {
    const err = Object.assign(new Error("cant open"), {
      code: "SQLITE_CANTOPEN",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("maps unknown codes to QUERY_FAILED", () => {
    const err = Object.assign(new Error("unknown"), {
      code: "SQLITE_UNKNOWN",
    });
    expect(mapSqliteErrorCode(err)).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("maps errors without code to QUERY_FAILED", () => {
    expect(mapSqliteErrorCode(new Error("generic"))).toBe(
      DatabaseErrorCode.QUERY_FAILED,
    );
  });
});
