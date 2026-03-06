/**
 * Adversarial E2E tests for the SQLite adapter.
 * Tests SQL injection, type coercion edge cases, boundary values,
 * Unicode/special characters, and concurrent write patterns.
 */

import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqliteDataSource } from "../../sqlite-data-source.js";

// Graceful skip if better-sqlite3 native module can't load
let canLoadSqlite = true;
try {
  const mod = await import("../../sqlite-data-source.js");
  const ds = new mod.SqliteDataSource({ filename: ":memory:" });
  await ds.close();
} catch (err: any) {
  if (err?.code === "ERR_DLOPEN_FAILED" || err?.message?.includes("NODE_MODULE_VERSION")) {
    canLoadSqlite = false;
  } else {
    throw err;
  }
}

describe.skipIf(!canLoadSqlite)("E2E: SQLite adversarial tests", () => {
  let ds: SqliteDataSource;
  let conn: Connection;

  beforeAll(async () => {
    const { SqliteDataSource: DS } = await import("../../sqlite-data-source.js");
    ds = new DS({ filename: ":memory:" });
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
      CREATE TABLE adv_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        value TEXT,
        num_val REAL,
        int_val INTEGER
      )
    `);
  });

  afterAll(async () => {
    if (conn && !conn.isClosed()) {
      await conn.close();
    }
    if (ds) {
      await ds.close();
    }
  });

  // ─────────────────────────────────────────────────
  // 1. SQL injection via entity fields
  // ─────────────────────────────────────────────────

  describe("SQL injection resistance", () => {
    it("handles single quotes in parameterized values", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "O'Brien");
      ps.setParameter(2, "It's a test");
      const count = await ps.executeUpdate();
      expect(count).toBe(1);

      const query = conn.prepareStatement("SELECT name, value FROM adv_test WHERE name = $1");
      query.setParameter(1, "O'Brien");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("name")).toBe("O'Brien");
      expect(rs.getString("value")).toBe("It's a test");
    });

    it("handles semicolons in parameterized values (no multi-statement injection)", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name) VALUES ($1)");
      ps.setParameter(1, "test; DROP TABLE adv_test; --");
      const count = await ps.executeUpdate();
      expect(count).toBe(1);

      // Table should still exist
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery("SELECT count(*) as cnt FROM adv_test");
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("cnt")).toBeGreaterThan(0);
    });

    it("handles SQL keywords in parameterized values", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name) VALUES ($1)");
      ps.setParameter(1, "SELECT * FROM sqlite_master WHERE type='table'");
      const count = await ps.executeUpdate();
      expect(count).toBe(1);
    });

    it("handles double quotes in parameterized values", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name) VALUES ($1)");
      ps.setParameter(1, 'value with "double quotes"');
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT name FROM adv_test WHERE name = $1");
      query.setParameter(1, 'value with "double quotes"');
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("name")).toBe('value with "double quotes"');
    });

    it("handles backslash sequences in parameterized values", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name) VALUES ($1)");
      ps.setParameter(1, "path\\to\\file");
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT name FROM adv_test WHERE name = $1");
      query.setParameter(1, "path\\to\\file");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("name")).toBe("path\\to\\file");
    });
  });

  // ─────────────────────────────────────────────────
  // 2. Type coercion edge cases
  // ─────────────────────────────────────────────────

  describe("type coercion edge cases", () => {
    it("handles null values correctly", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value, num_val) VALUES ($1, $2, $3)");
      ps.setParameter(1, "null_test");
      ps.setParameter(2, null);
      ps.setParameter(3, null);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value, num_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "null_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBeNull();
      expect(rs.getNumber("num_val")).toBeNull();
    });

    it("handles empty string vs null", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "empty_string_test");
      ps.setParameter(2, "");
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "empty_string_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      // Empty string is NOT null
      expect(rs.getString("value")).toBe("");
    });

    it("handles NaN stored as REAL", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, num_val) VALUES ($1, $2)");
      ps.setParameter(1, "nan_test");
      ps.setParameter(2, NaN);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT num_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "nan_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      // SQLite stores NaN as NULL
      expect(rs.getNumber("num_val")).toBeNull();
    });

    it("handles Infinity stored as REAL", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, num_val) VALUES ($1, $2)");
      ps.setParameter(1, "infinity_test");
      ps.setParameter(2, Infinity);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT num_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "infinity_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      // SQLite may store Infinity as NULL or as a special value
      const val = rs.getNumber("num_val");
      // Either null or Infinity is acceptable behavior
      expect(val === null || val === Infinity).toBe(true);
    });

    it("handles very long strings", async () => {
      const longString = "x".repeat(100_000);
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "long_string_test");
      ps.setParameter(2, longString);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "long_string_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBe(longString);
    });

    it("handles boolean values stored as INTEGER", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
      ps.setParameter(1, "bool_true");
      ps.setParameter(2, 1); // SQLite stores booleans as INTEGER 0/1
      await ps.executeUpdate();

      const ps2 = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
      ps2.setParameter(1, "bool_false");
      ps2.setParameter(2, 0);
      await ps2.executeUpdate();

      const query = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "bool_true");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("int_val")).toBe(1);

      const query2 = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
      query2.setParameter(1, "bool_false");
      const rs2 = await query2.executeQuery();
      expect(await rs2.next()).toBe(true);
      expect(rs2.getNumber("int_val")).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────
  // 3. Boundary values
  // ─────────────────────────────────────────────────

  describe("boundary values", () => {
    it("handles MAX_SAFE_INTEGER", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
      ps.setParameter(1, "max_safe_int");
      ps.setParameter(2, Number.MAX_SAFE_INTEGER);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "max_safe_int");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("int_val")).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("handles negative numbers", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
      ps.setParameter(1, "negative");
      ps.setParameter(2, -2147483648);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "negative");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("int_val")).toBe(-2147483648);
    });

    it("handles zero", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
      ps.setParameter(1, "zero_val");
      ps.setParameter(2, 0);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "zero_val");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("int_val")).toBe(0);
    });

    it("handles floating point precision", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, num_val) VALUES ($1, $2)");
      ps.setParameter(1, "float_precision");
      ps.setParameter(2, 0.1 + 0.2);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT num_val FROM adv_test WHERE name = $1");
      query.setParameter(1, "float_precision");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      const val = rs.getNumber("num_val");
      expect(val).toBeCloseTo(0.3, 10);
    });
  });

  // ─────────────────────────────────────────────────
  // 4. Unicode and special characters
  // ─────────────────────────────────────────────────

  describe("Unicode and special characters", () => {
    it("handles emoji characters", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "emoji_test");
      ps.setParameter(2, "Hello World! \u{1F600}\u{1F4AF}\u{1F680}");
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "emoji_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBe("Hello World! \u{1F600}\u{1F4AF}\u{1F680}");
    });

    it("handles null bytes in strings", async () => {
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "null_byte_test");
      ps.setParameter(2, "before\0after");
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "null_byte_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      const val = rs.getString("value");
      // SQLite may truncate at null byte or store it
      expect(val).toBeDefined();
    });

    it("handles RTL text (Arabic)", async () => {
      const rtlText = "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645";
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "rtl_test");
      ps.setParameter(2, rtlText);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "rtl_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBe(rtlText);
    });

    it("handles CJK characters", async () => {
      const cjkText = "\u4F60\u597D\u4E16\u754C \u3053\u3093\u306B\u3061\u306F \uD55C\uAD6D\uC5B4";
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "cjk_test");
      ps.setParameter(2, cjkText);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "cjk_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBe(cjkText);
    });

    it("handles mixed Unicode combining characters", async () => {
      // e + combining acute accent
      const combining = "e\u0301";
      const ps = conn.prepareStatement("INSERT INTO adv_test (name, value) VALUES ($1, $2)");
      ps.setParameter(1, "combining_test");
      ps.setParameter(2, combining);
      await ps.executeUpdate();

      const query = conn.prepareStatement("SELECT value FROM adv_test WHERE name = $1");
      query.setParameter(1, "combining_test");
      const rs = await query.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("value")).toBe(combining);
    });
  });

  // ─────────────────────────────────────────────────
  // 5. Concurrent write patterns
  // ─────────────────────────────────────────────────

  describe("concurrent write patterns", () => {
    it("handles rapid sequential inserts", async () => {
      const promises: Promise<number>[] = [];
      for (let i = 0; i < 100; i++) {
        const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
        ps.setParameter(1, `rapid_${i}`);
        ps.setParameter(2, i);
        promises.push(ps.executeUpdate());
      }

      const results = await Promise.all(promises);
      expect(results.every((r) => r === 1)).toBe(true);

      // Verify all rows inserted
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery("SELECT count(*) as cnt FROM adv_test WHERE name LIKE 'rapid_%'");
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("cnt")).toBe(100);
    });

    it("handles insert + select interleaving", async () => {
      // Insert and immediately read back
      for (let i = 0; i < 10; i++) {
        const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
        ps.setParameter(1, `interleave_${i}`);
        ps.setParameter(2, i * 10);
        await ps.executeUpdate();

        const query = conn.prepareStatement("SELECT int_val FROM adv_test WHERE name = $1");
        query.setParameter(1, `interleave_${i}`);
        const rs = await query.executeQuery();
        expect(await rs.next()).toBe(true);
        expect(rs.getNumber("int_val")).toBe(i * 10);
      }
    });

    it("handles concurrent reads while writing", async () => {
      // Insert a batch of rows
      for (let i = 0; i < 5; i++) {
        const ps = conn.prepareStatement("INSERT INTO adv_test (name, int_val) VALUES ($1, $2)");
        ps.setParameter(1, `concurrent_${i}`);
        ps.setParameter(2, i);
        await ps.executeUpdate();
      }

      // Concurrent reads should all succeed
      const readPromises = Array.from({ length: 10 }, async () => {
        const stmt = conn.createStatement();
        const rs = await stmt.executeQuery("SELECT count(*) as cnt FROM adv_test WHERE name LIKE 'concurrent_%'");
        expect(await rs.next()).toBe(true);
        return rs.getNumber("cnt");
      });

      const counts = await Promise.all(readPromises);
      // All reads should see 5 rows
      expect(counts.every((c) => c === 5)).toBe(true);
    });
  });
});
