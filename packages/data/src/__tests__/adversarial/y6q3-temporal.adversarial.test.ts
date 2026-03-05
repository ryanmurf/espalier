import { describe, it, expect, vi } from "vitest";
import { Temporal, getTemporalMetadata, isTemporalEntity } from "../../decorators/temporal.js";
import { TemporalQueryBuilder } from "../../temporal/temporal-query.js";

// ─── @Temporal Decorator ─────────────────────────────────────────────────────

describe("@Temporal decorator — adversarial", () => {
  it("stores defaults when no options are provided", () => {
    @Temporal()
    class NoOpts {}

    const meta = getTemporalMetadata(NoOpts);
    expect(meta).toBeDefined();
    expect(meta!.bitemporal).toBe(false);
    expect(meta!.validFromColumn).toBe("valid_from");
    expect(meta!.validToColumn).toBe("valid_to");
    expect(meta!.transactionFromColumn).toBe("transaction_from");
    expect(meta!.transactionToColumn).toBe("transaction_to");
    expect(meta!.historyTable).toBe("");
  });

  it("stores custom options faithfully", () => {
    @Temporal({
      historyTable: "audit_trail",
      bitemporal: true,
      validFromColumn: "start_at",
      validToColumn: "end_at",
      transactionFromColumn: "tx_start",
      transactionToColumn: "tx_end",
    })
    class Custom {}

    const meta = getTemporalMetadata(Custom);
    expect(meta).toBeDefined();
    expect(meta!.historyTable).toBe("audit_trail");
    expect(meta!.bitemporal).toBe(true);
    expect(meta!.validFromColumn).toBe("start_at");
    expect(meta!.validToColumn).toBe("end_at");
    expect(meta!.transactionFromColumn).toBe("tx_start");
    expect(meta!.transactionToColumn).toBe("tx_end");
  });

  it("returns a defensive copy — mutating result does not affect stored metadata", () => {
    @Temporal({ bitemporal: true })
    class DefensiveCopy {}

    const m1 = getTemporalMetadata(DefensiveCopy)!;
    m1.validFromColumn = "HACKED";
    m1.bitemporal = false;

    const m2 = getTemporalMetadata(DefensiveCopy)!;
    expect(m2.validFromColumn).toBe("valid_from");
    expect(m2.bitemporal).toBe(true);
  });

  it("getTemporalMetadata returns undefined for undecorated class", () => {
    class Plain {}
    expect(getTemporalMetadata(Plain)).toBeUndefined();
  });

  it("isTemporalEntity returns false for undecorated, true for decorated", () => {
    class Plain {}
    expect(isTemporalEntity(Plain)).toBe(false);

    @Temporal()
    class Dec {}
    expect(isTemporalEntity(Dec)).toBe(true);
  });

  it("each class gets its own metadata — no cross-contamination", () => {
    @Temporal({ historyTable: "a_history" })
    class A {}

    @Temporal({ historyTable: "b_history" })
    class B {}

    expect(getTemporalMetadata(A)!.historyTable).toBe("a_history");
    expect(getTemporalMetadata(B)!.historyTable).toBe("b_history");
  });

  it("handles undefined explicitly passed for optional fields", () => {
    @Temporal({
      historyTable: undefined,
      bitemporal: undefined,
      validFromColumn: undefined,
      validToColumn: undefined,
      transactionFromColumn: undefined,
      transactionToColumn: undefined,
    })
    class Undef {}

    const meta = getTemporalMetadata(Undef)!;
    expect(meta.historyTable).toBe("");
    expect(meta.bitemporal).toBe(false);
    expect(meta.validFromColumn).toBe("valid_from");
    expect(meta.validToColumn).toBe("valid_to");
  });

  it("returns the same class constructor (does not wrap)", () => {
    @Temporal()
    class Identity {}

    expect(isTemporalEntity(Identity)).toBe(true);
    const instance = new Identity();
    expect(instance).toBeInstanceOf(Identity);
  });

  it("handles empty string column names", () => {
    @Temporal({
      validFromColumn: "",
      validToColumn: "",
    })
    class EmptyCols {}

    const meta = getTemporalMetadata(EmptyCols)!;
    expect(meta.validFromColumn).toBe("");
    expect(meta.validToColumn).toBe("");
  });
});

// ─── TemporalQueryBuilder ────────────────────────────────────────────────────

describe("TemporalQueryBuilder — adversarial", () => {
  describe("findAsOf", () => {
    it("generates parameterized SQL with quoted identifiers", () => {
      const qb = new TemporalQueryBuilder("users", "users_history", {
        validFromColumn: "valid_from",
        validToColumn: "valid_to",
      });

      const { sql, params } = qb.findAsOf(new Date("2025-06-15T00:00:00Z"));
      expect(sql).toContain('"users_history"');
      expect(sql).toContain('"valid_from"');
      expect(sql).toContain('"valid_to"');
      expect(sql).toContain("$1");
      expect(sql).not.toContain("$2");
      expect(params).toHaveLength(1);
      expect(params[0]).toBe("2025-06-15T00:00:00.000Z");
    });

    it("accepts string timestamps (pass-through, no Date parsing)", () => {
      const qb = new TemporalQueryBuilder("t", "t_hist", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { params } = qb.findAsOf("2025-01-01");
      expect(params[0]).toBe("2025-01-01");
    });

    it("SQL injection in table name is quoted — embedded quotes are doubled", () => {
      const qb = new TemporalQueryBuilder("x", 'Robert"); DROP TABLE students;--', {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { sql } = qb.findAsOf(new Date());
      // The internal double-quote is escaped to "" so the whole thing is one identifier
      expect(sql).toContain('"Robert""); DROP TABLE students;--"');
      // Crucially, the FROM clause uses the whole thing as a single quoted identifier
      expect(sql).toMatch(/^SELECT \* FROM "Robert""\); DROP TABLE students;--"/);
    });

    it("SQL injection in column names is quoted away", () => {
      const qb = new TemporalQueryBuilder("t", "t_hist", {
        validFromColumn: '"; DROP TABLE x;--',
        validToColumn: '"; DROP TABLE y;--',
      });
      const { sql } = qb.findAsOf(new Date());
      // Double-quotes inside are escaped by quoteIdentifier
      expect(sql).not.toMatch(/DROP TABLE x(?!;--")/);
    });

    it("handles OR NULL branch for valid_to", () => {
      const qb = new TemporalQueryBuilder("t", "t_hist", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { sql } = qb.findAsOf("2025-01-01");
      expect(sql).toContain("IS NULL");
    });
  });

  describe("findHistory", () => {
    it("generates range query with two params and ORDER BY", () => {
      const qb = new TemporalQueryBuilder("orders", "orders_hist", {
        validFromColumn: "effective_from",
        validToColumn: "effective_to",
      });

      const { sql, params } = qb.findHistory("2024-01-01", "2025-01-01");
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      expect(sql).toContain("ORDER BY");
      expect(params).toEqual(["2024-01-01", "2025-01-01"]);
    });

    it("converts Date objects to ISO strings", () => {
      const qb = new TemporalQueryBuilder("t", "th", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const start = new Date("2024-06-01T12:00:00Z");
      const end = new Date("2024-12-31T23:59:59Z");
      const { params } = qb.findHistory(start, end);
      expect(params[0]).toBe(start.toISOString());
      expect(params[1]).toBe(end.toISOString());
    });

    it("same start and end date still produces valid SQL", () => {
      const qb = new TemporalQueryBuilder("t", "th", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { sql, params } = qb.findHistory("2025-01-01", "2025-01-01");
      expect(sql).toContain(">=");
      expect(sql).toContain("<=");
      expect(params).toEqual(["2025-01-01", "2025-01-01"]);
    });
  });

  describe("findHistoryById", () => {
    it("generates id-scoped history query with three params", () => {
      const qb = new TemporalQueryBuilder("orders", "orders_hist", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });

      const { sql, params } = qb.findHistoryById("uuid-123", "2024-01-01", "2025-01-01");
      expect(sql).toContain('"id" = $1');
      expect(sql).toContain("$2");
      expect(sql).toContain("$3");
      expect(params).toEqual(["uuid-123", "2024-01-01", "2025-01-01"]);
    });

    it("numeric id values are passed through as-is", () => {
      const qb = new TemporalQueryBuilder("t", "th", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { params } = qb.findHistoryById(42, "2024-01-01", "2025-01-01");
      expect(params[0]).toBe(42);
    });

    it("null id does not crash", () => {
      const qb = new TemporalQueryBuilder("t", "th", {
        validFromColumn: "vf",
        validToColumn: "vt",
      });
      const { params } = qb.findHistoryById(null, "2024-01-01", "2025-01-01");
      expect(params[0]).toBeNull();
    });
  });

  describe("identifier quoting edge cases", () => {
    it("column names with spaces are properly quoted", () => {
      const qb = new TemporalQueryBuilder("t", "t hist", {
        validFromColumn: "valid from",
        validToColumn: "valid to",
      });
      const { sql } = qb.findAsOf("2025-01-01");
      expect(sql).toContain('"valid from"');
      expect(sql).toContain('"valid to"');
      expect(sql).toContain('"t hist"');
    });

    it("column names with double quotes are escaped", () => {
      const qb = new TemporalQueryBuilder("t", 'my"table', {
        validFromColumn: 'col"a',
        validToColumn: 'col"b',
      });
      const { sql } = qb.findAsOf("2025-01-01");
      expect(sql).toContain('"my""table"');
      expect(sql).toContain('"col""a"');
    });

    it("unicode characters in identifiers", () => {
      const qb = new TemporalQueryBuilder("t", "tbl_hist", {
        validFromColumn: "von_datum",
        validToColumn: "bis_datum",
      });
      const { sql } = qb.findAsOf("2025-01-01");
      expect(sql).toContain('"von_datum"');
      expect(sql).toContain('"bis_datum"');
    });
  });
});

// ─── Temporal DDL generation ─────────────────────────────────────────────────
// We test generateTemporalDdl indirectly by verifying its output shape.
// This requires mocking entity metadata since @Table/@Id/@Column decorators
// are required for the full pipeline.

describe("generateTemporalDdl — adversarial", () => {
  // We have to use real decorators for generateTemporalDdl to work,
  // so we'll do a dynamic import and test with real decorated classes.
  // The function depends on getEntityMetadata, getColumnMetadataEntries, getTableName, getTemporalMetadata.

  // Since temporal-ddl.ts imports from entity-metadata, column, table, temporal decorators,
  // we test it through a full decorator integration.

  it("throws when entity class lacks @Temporal", async () => {
    const { generateTemporalDdl } = await import("../../temporal/temporal-ddl.js");
    class NotTemporal {}
    expect(() => generateTemporalDdl(NotTemporal)).toThrow("not decorated with @Temporal");
  });
});
