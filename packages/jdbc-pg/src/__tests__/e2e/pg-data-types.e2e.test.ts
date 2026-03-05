import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { PgDataSource } from "../../pg-data-source.js";
import {
  createTestDataSource,
  isPostgresAvailable,
  dropTestTable,
} from "./setup.js";

const TABLE = "e2e_data_types";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)(
  "E2E: Data type handling",
  { timeout: 10000 },
  () => {
    let ds: PgDataSource;
    let conn: Connection;

    beforeAll(async () => {
      ds = createTestDataSource();
      conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(dropTestTable(TABLE));
      await stmt.executeUpdate(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          text_col TEXT,
          int_col INT,
          bigint_col BIGINT,
          float_col DOUBLE PRECISION,
          bool_col BOOLEAN,
          bytea_col BYTEA,
          ts_col TIMESTAMPTZ,
          json_col JSONB,
          nullable_col TEXT
        )
      `);
    });

    afterAll(async () => {
      if (conn && !conn.isClosed()) {
        const stmt = conn.createStatement();
        await stmt.executeUpdate(dropTestTable(TABLE));
        await conn.close();
      }
      if (ds) {
        await ds.close();
      }
    });

    it("handles NULL values for all nullable columns", async () => {
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, int_col, float_col, bool_col, nullable_col)
         VALUES ($1, $2, $3, $4, $5)`,
      );
      ps.setParameter(1, null);
      ps.setParameter(2, null);
      ps.setParameter(3, null);
      ps.setParameter(4, null);
      ps.setParameter(5, null);
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT 1`,
      );
      expect(await rs.next()).toBe(true);
      expect(rs.getString("text_col")).toBeNull();
      expect(rs.getNumber("int_col")).toBeNull();
      expect(rs.getNumber("float_col")).toBeNull();
      expect(rs.getBoolean("bool_col")).toBeNull();
      expect(rs.getString("nullable_col")).toBeNull();
    });

    it("handles boolean true and false", async () => {
      const psTrue = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, bool_col) VALUES ($1, $2)`,
      );
      psTrue.setParameter(1, "bool_true");
      psTrue.setParameter(2, true);
      await psTrue.executeUpdate();

      const psFalse = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, bool_col) VALUES ($1, $2)`,
      );
      psFalse.setParameter(1, "bool_false");
      psFalse.setParameter(2, false);
      await psFalse.executeUpdate();

      const stmt = conn.createStatement();
      const rsTrue = await stmt.executeQuery(
        `SELECT bool_col FROM ${TABLE} WHERE text_col = 'bool_true'`,
      );
      expect(await rsTrue.next()).toBe(true);
      expect(rsTrue.getBoolean("bool_col")).toBe(true);

      const rsFalse = await stmt.executeQuery(
        `SELECT bool_col FROM ${TABLE} WHERE text_col = 'bool_false'`,
      );
      expect(await rsFalse.next()).toBe(true);
      expect(rsFalse.getBoolean("bool_col")).toBe(false);
    });

    it("handles integer boundary values", async () => {
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, int_col) VALUES ($1, $2)`,
      );
      ps.setParameter(1, "max_int");
      ps.setParameter(2, 2147483647);
      await ps.executeUpdate();

      const ps2 = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, int_col) VALUES ($1, $2)`,
      );
      ps2.setParameter(1, "min_int");
      ps2.setParameter(2, -2147483648);
      await ps2.executeUpdate();

      const stmt = conn.createStatement();
      const rsMax = await stmt.executeQuery(
        `SELECT int_col FROM ${TABLE} WHERE text_col = 'max_int'`,
      );
      expect(await rsMax.next()).toBe(true);
      expect(rsMax.getNumber("int_col")).toBe(2147483647);

      const rsMin = await stmt.executeQuery(
        `SELECT int_col FROM ${TABLE} WHERE text_col = 'min_int'`,
      );
      expect(await rsMin.next()).toBe(true);
      expect(rsMin.getNumber("int_col")).toBe(-2147483648);
    });

    it("handles floating point values", async () => {
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, float_col) VALUES ($1, $2)`,
      );
      ps.setParameter(1, "float_test");
      ps.setParameter(2, 3.141592653589793);
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT float_col FROM ${TABLE} WHERE text_col = 'float_test'`,
      );
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("float_col")).toBeCloseTo(3.141592653589793, 10);
    });

    it("handles timestamptz values", async () => {
      const now = new Date();
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, ts_col) VALUES ($1, $2)`,
      );
      ps.setParameter(1, "ts_test");
      ps.setParameter(2, now);
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT ts_col FROM ${TABLE} WHERE text_col = 'ts_test'`,
      );
      expect(await rs.next()).toBe(true);
      const retrieved = rs.getDate("ts_col");
      expect(retrieved).toBeInstanceOf(Date);
      // Allow up to 1 second difference due to postgres precision
      expect(Math.abs(retrieved!.getTime() - now.getTime())).toBeLessThan(
        1000,
      );
    });

    it("handles Uint8Array (bytea) values", async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x42]);
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, bytea_col) VALUES ($1, $2)`,
      );
      ps.setParameter(1, "bytea_test");
      ps.setParameter(2, bytes);
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT bytea_col FROM ${TABLE} WHERE text_col = 'bytea_test'`,
      );
      expect(await rs.next()).toBe(true);
      const row = rs.getRow();
      const retrieved = row.bytea_col as Uint8Array;
      expect(retrieved).toBeTruthy();
      expect(retrieved[0]).toBe(0x00);
      expect(retrieved[1]).toBe(0x01);
      expect(retrieved[2]).toBe(0xff);
      expect(retrieved[3]).toBe(0xfe);
      expect(retrieved[4]).toBe(0x42);
    });

    it("handles special characters in text", async () => {
      const special = "O'Reilly & Co. <test> \"quoted\" \\ backslash";
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col) VALUES ($1)`,
      );
      ps.setParameter(1, special);
      await ps.executeUpdate();

      const selectPs = conn.prepareStatement(
        `SELECT text_col FROM ${TABLE} WHERE text_col = $1`,
      );
      selectPs.setParameter(1, special);
      const rs = await selectPs.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("text_col")).toBe(special);
    });

    it("handles unicode text", async () => {
      const unicode = "Hello \u4e16\u754c \ud83c\udf0d \u00e9\u00e8\u00ea \u00fc\u00f6\u00e4";
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col) VALUES ($1)`,
      );
      ps.setParameter(1, unicode);
      await ps.executeUpdate();

      const selectPs = conn.prepareStatement(
        `SELECT text_col FROM ${TABLE} WHERE text_col = $1`,
      );
      selectPs.setParameter(1, unicode);
      const rs = await selectPs.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("text_col")).toBe(unicode);
    });

    it("handles empty string vs NULL", async () => {
      const ps = conn.prepareStatement(
        `INSERT INTO ${TABLE} (text_col, nullable_col) VALUES ($1, $2)`,
      );
      ps.setParameter(1, "empty_vs_null");
      ps.setParameter(2, "");
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT nullable_col FROM ${TABLE} WHERE text_col = 'empty_vs_null'`,
      );
      expect(await rs.next()).toBe(true);
      expect(rs.getString("nullable_col")).toBe("");
    });
  },
);
