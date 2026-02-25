import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgConnection } from "../../pg-connection.js";
import type { PgDataSource } from "../../pg-data-source.js";
import {
  createTestDataSource,
  isPostgresAvailable,
  dropTestTable,
} from "./setup.js";

const TABLE = "e2e_named_params";
const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)(
  "E2E: Named parameter queries",
  { timeout: 10000 },
  () => {
    let ds: PgDataSource;
    let conn: PgConnection;

    beforeAll(async () => {
      ds = createTestDataSource();
      // We need PgConnection directly for prepareNamedStatement
      const rawConn = await ds.getConnection();
      conn = rawConn as PgConnection;
      const stmt = conn.createStatement();
      await stmt.executeUpdate(dropTestTable(TABLE));
      await stmt.executeUpdate(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          age INT,
          active BOOLEAN DEFAULT true
        )
      `);
    });

    beforeEach(async () => {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DELETE FROM ${TABLE}`);
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

    it("inserts a row with named parameters", async () => {
      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES (:name, :email, :age)`,
      );
      ps.setNamedParameter("name", "Alice");
      ps.setNamedParameter("email", "alice@example.com");
      ps.setNamedParameter("age", 30);
      const count = await ps.executeUpdate();
      expect(count).toBe(1);
    });

    it("selects with named parameter WHERE clause", async () => {
      // Insert first
      const insert = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES (:name, :email, :age)`,
      );
      insert.setNamedParameter("name", "Bob");
      insert.setNamedParameter("email", "bob@example.com");
      insert.setNamedParameter("age", 25);
      await insert.executeUpdate();

      const ps = conn.prepareNamedStatement(
        `SELECT * FROM ${TABLE} WHERE name = :name`,
      );
      ps.setNamedParameter("name", "Bob");
      const rs = await ps.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("name")).toBe("Bob");
      expect(rs.getString("email")).toBe("bob@example.com");
      expect(rs.getNumber("age")).toBe(25);
      expect(await rs.next()).toBe(false);
    });

    it("updates with named parameters", async () => {
      const insert = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, age) VALUES (:name, :age)`,
      );
      insert.setNamedParameter("name", "Charlie");
      insert.setNamedParameter("age", 35);
      await insert.executeUpdate();

      const update = conn.prepareNamedStatement(
        `UPDATE ${TABLE} SET age = :newAge WHERE name = :name`,
      );
      update.setNamedParameter("newAge", 36);
      update.setNamedParameter("name", "Charlie");
      const count = await update.executeUpdate();
      expect(count).toBe(1);

      // Verify
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT age FROM ${TABLE} WHERE name = 'Charlie'`,
      );
      await rs.next();
      expect(rs.getNumber("age")).toBe(36);
    });

    it("deletes with named parameters", async () => {
      const insert = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, age) VALUES (:name, :age)`,
      );
      insert.setNamedParameter("name", "ToDelete");
      insert.setNamedParameter("age", 99);
      await insert.executeUpdate();

      const del = conn.prepareNamedStatement(
        `DELETE FROM ${TABLE} WHERE name = :name`,
      );
      del.setNamedParameter("name", "ToDelete");
      const count = await del.executeUpdate();
      expect(count).toBe(1);

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name = 'ToDelete'`,
      );
      await rs.next();
      expect(rs.getNumber("cnt")).toBe(0);
    });

    it("handles multiple different named parameters", async () => {
      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email, age, active)
         VALUES (:name, :email, :age, :active)`,
      );
      ps.setNamedParameter("name", "Diana");
      ps.setNamedParameter("email", "diana@example.com");
      ps.setNamedParameter("age", 28);
      ps.setNamedParameter("active", true);
      await ps.executeUpdate();

      const select = conn.prepareNamedStatement(
        `SELECT * FROM ${TABLE} WHERE name = :name AND age = :age`,
      );
      select.setNamedParameter("name", "Diana");
      select.setNamedParameter("age", 28);
      const rs = await select.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("email")).toBe("diana@example.com");
      expect(rs.getBoolean("active")).toBe(true);
    });

    it("handles reused named parameter (same name appears twice)", async () => {
      const insert = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, age) VALUES (:name, :age)`,
      );
      insert.setNamedParameter("name", "Eve");
      insert.setNamedParameter("age", 22);
      await insert.executeUpdate();

      insert.setNamedParameter("name", "Adam");
      insert.setNamedParameter("age", 24);
      await insert.executeUpdate();

      // Query where both conditions use the same param name
      const ps = conn.prepareNamedStatement(
        `SELECT * FROM ${TABLE} WHERE age >= :minAge AND age <= :minAge + 5`,
      );
      ps.setNamedParameter("minAge", 22);
      const rs = await ps.executeQuery();
      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      // Both Eve (22) and Adam (24) should match 22 <= age <= 27
      expect(rows.length).toBe(2);
    });

    it("handles NULL named parameter values", async () => {
      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES (:name, :email, :age)`,
      );
      ps.setNamedParameter("name", "NullEmail");
      ps.setNamedParameter("email", null);
      ps.setNamedParameter("age", null);
      await ps.executeUpdate();

      const select = conn.prepareNamedStatement(
        `SELECT email, age FROM ${TABLE} WHERE name = :name`,
      );
      select.setNamedParameter("name", "NullEmail");
      const rs = await select.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getString("email")).toBeNull();
      expect(rs.getNumber("age")).toBeNull();
    });

    it("named params work within a transaction", async () => {
      const tx = await conn.beginTransaction();

      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, age) VALUES (:name, :age)`,
      );
      ps.setNamedParameter("name", "TxNamed");
      ps.setNamedParameter("age", 50);
      await ps.executeUpdate();

      await tx.rollback();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE name = 'TxNamed'`,
      );
      await rs.next();
      expect(rs.getNumber("cnt")).toBe(0);
    });

    it("named params work with RETURNING clause", async () => {
      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email, age) VALUES (:name, :email, :age) RETURNING id, name`,
      );
      ps.setNamedParameter("name", "Returning");
      ps.setNamedParameter("email", "ret@example.com");
      ps.setNamedParameter("age", 40);
      const rs = await ps.executeQuery();
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("id")).toBeGreaterThan(0);
      expect(rs.getString("name")).toBe("Returning");
    });

    it("throws QueryError for invalid named param SQL", async () => {
      const ps = conn.prepareNamedStatement(
        `SELEKT * FROM ${TABLE} WHERE name = :name`,
      );
      ps.setNamedParameter("name", "test");
      try {
        await ps.executeQuery();
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        const qe = err as { name: string };
        expect(qe.name).toBe("QueryError");
      }
    });

    it("missing named parameter defaults to null", async () => {
      const ps = conn.prepareNamedStatement(
        `INSERT INTO ${TABLE} (name, email) VALUES (:name, :email)`,
      );
      ps.setNamedParameter("name", "MissingParam");
      // Intentionally not setting :email
      await ps.executeUpdate();

      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT email FROM ${TABLE} WHERE name = 'MissingParam'`,
      );
      await rs.next();
      expect(rs.getString("email")).toBeNull();
    });

    it("prepareNamedStatement throws when connection is closed", async () => {
      const conn2 = (await ds.getConnection()) as PgConnection;
      await conn2.close();
      expect(() =>
        conn2.prepareNamedStatement(`SELECT * FROM ${TABLE} WHERE name = :name`),
      ).toThrow("Connection is closed");
    });
  },
);
