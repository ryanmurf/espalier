import { describe, expect, it } from "vitest";
import { IsolationLevel } from "../transaction.js";

describe("IsolationLevel", () => {
  it("READ_UNCOMMITTED maps to correct SQL string", () => {
    expect(IsolationLevel.READ_UNCOMMITTED).toBe("READ UNCOMMITTED");
  });

  it("READ_COMMITTED maps to correct SQL string", () => {
    expect(IsolationLevel.READ_COMMITTED).toBe("READ COMMITTED");
  });

  it("REPEATABLE_READ maps to correct SQL string", () => {
    expect(IsolationLevel.REPEATABLE_READ).toBe("REPEATABLE READ");
  });

  it("SERIALIZABLE maps to correct SQL string", () => {
    expect(IsolationLevel.SERIALIZABLE).toBe("SERIALIZABLE");
  });

  it("has exactly four members", () => {
    const values = Object.values(IsolationLevel);
    expect(values).toHaveLength(4);
  });
});
